import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import mqtt from 'mqtt';

type GateState = 'CLOSED' | 'OPENING' | 'OPEN' | 'CLOSING' | 'STOPPED' | 'FAULT' | 'UNKNOWN';
type CommandType = 'OPEN' | 'CLOSE' | 'STOP';

interface SignedCommand {
  commandId: string;
  deviceId: string;
  accessPointId: string;
  type: CommandType;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

interface Ack {
  commandId: string;
  status: 'ACK' | 'EXECUTED' | 'FAILED';
  nonce: string;
  gateState?: GateState;
  signedAt: string;
}

interface DeviceIdentity {
  id: string;
  deviceUid: string;
  name: string;
  societyId: string;
  status: string;
  firmware: string | null;
  accessPoints: { accessPoint: { id: string; name: string; type: string; location: string | null } }[];
}

interface VerifyResponse {
  decision: 'AUTHORIZED' | 'DENIED';
  reasonCode: string;
  accessEventId: string;
  commandId?: string;
  expiresAt?: string;
}

// dotenv is not a dependency of this package (the import crashed with MODULE_NOT_FOUND);
// Node's built-in loader has the same semantics: existing env vars win over .env values.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// The simulator ships demo secrets and seeds a test PIN; it must never run as a production controller.
if (process.env.NODE_ENV === 'production') {
  console.error('device-simulator is a development tool and refuses to start with NODE_ENV=production.');
  process.exit(1);
}

const env = {
  apiUrl: (process.env.API_URL || process.env.WEB_URL || 'http://localhost:80').replace(/\/$/, ''),
  mqttUrl: process.env.MQTT_URL?.trim() || '',
  mqttUsername: process.env.MQTT_USERNAME?.trim() || undefined,
  mqttPassword: process.env.MQTT_PASSWORD || undefined,
  deviceToken: process.env.DEVICE_TOKEN?.trim() || 'sos_dev_demo_simulator_token_a_change_me_2026',
  commandSecret: process.env.COMMAND_SECRET?.trim() || 'demo-command-secret-a-change-me-2026',
  credentialHmacKey: process.env.CREDENTIAL_HMAC_KEY?.trim() || 'dev-only-credential-hmac-key-change-me-32-bytes',
  credentialHmacKeyId: process.env.CREDENTIAL_HMAC_KEY_ID?.trim() || 'v1',
  gateId: process.env.ACCESS_POINT_ID?.trim() || undefined,
  heartbeatSeconds: Number.parseInt(process.env.HEARTBEAT_SECONDS || '30', 10) || 30,
  motionMs: Number.parseInt(process.env.GATE_MOTION_MS || '1500', 10) || 1500,
};

const startedAt = Date.now();
let gateState: GateState = 'CLOSED';
let obstructionActive = false;
let sensorFault = false;
let identity: DeviceIdentity | null = null;
let mqttClient: mqtt.MqttClient | null = null;
let operation: Promise<void> = Promise.resolve();

function log(message: string): void {
  console.log(`[sim ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function signingString(command: Omit<SignedCommand, 'signature'>): string {
  return [
    'societyos-command-v1',
    command.commandId,
    command.deviceId,
    command.accessPointId,
    command.type,
    command.nonce,
    command.issuedAt,
    command.expiresAt,
  ].join('\n');
}

function ackString(ack: Ack): string {
  return ['societyos-ack-v1', ack.commandId, ack.status, ack.nonce, ack.gateState || '', ack.signedAt].join(
    '\n',
  );
}

function hmac(value: string): string {
  return crypto.createHmac('sha256', env.commandSecret).update(value).digest('base64url');
}

function hashCredential(credential: string): string {
  const version = env.credentialHmacKeyId;
  const key = `${version}:${env.credentialHmacKey}`;
  return crypto.createHmac('sha256', key).update(credential).digest('hex');
}

function verifySignature(command: SignedCommand): boolean {
  const expected = Buffer.from(hmac(signingString(command)));
  const provided = Buffer.from(command.signature);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${env.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.deviceToken}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const error = body as { message?: string; code?: string } | undefined;
    throw new Error(`${response.status} ${error?.code ?? 'REQUEST_FAILED'}: ${error?.message ?? 'request failed'}`);
  }
  return body as T;
}

async function loadIdentity(): Promise<DeviceIdentity> {
  const device = await api<DeviceIdentity>('/api/v1/device-api/me');
  log(`identified as ${device.name} (${device.deviceUid}) in society ${device.societyId}`);
  for (const link of device.accessPoints) {
    log(`  gate ${link.accessPoint.name} · ${link.accessPoint.type} · ${link.accessPoint.id}`);
  }
  return device;
}

function assignedGate(accessPointId: string): string | null {
  const gate = identity?.accessPoints.find((link) => link.accessPoint.id === accessPointId);
  return gate ? gate.accessPoint.name : null;
}

function publish(topic: string, payload: unknown): void {
  if (isOffline) {
    log(`offline mode active; suppressing outgoing MQTT message for ${topic}`);
    return;
  }
  if (!mqttClient?.connected) {
    log(`MQTT offline; dropping message for ${topic}`);
    return;
  }
  mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
    if (error) log(`publish failed on ${topic}: ${error.message}`);
  });
}

function sendAck(command: SignedCommand, status: Ack['status']): void {
  if (!identity) return;
  const ack: Ack = {
    commandId: command.commandId,
    status,
    nonce: command.nonce,
    ...(status === 'ACK' || status === 'EXECUTED' ? { gateState } : {}),
    signedAt: new Date().toISOString(),
  };
  publish(`society/${identity.societyId}/device/${identity.id}/acknowledgements`, {
    ...ack,
    signature: hmac(ackString(ack)),
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveGate(command: SignedCommand): Promise<void> {
  if (sensorFault) {
    log(`refused command ${command.commandId.slice(0, 8)}: controller is in FAULT state`);
    sendAck(command, 'FAILED');
    return;
  }
  if (command.type === 'CLOSE' && obstructionActive) {
    log(`refused CLOSE command ${command.commandId.slice(0, 8)}: obstruction / safety loop active`);
    gateState = 'STOPPED';
    sendAck(command, 'FAILED');
    return;
  }
  sendAck(command, 'ACK');
  if (command.type === 'OPEN') {
    if (gateState === 'OPEN') {
      sendAck(command, 'EXECUTED');
      return;
    }
    if (gateState !== 'OPENING') {
      gateState = 'OPENING';
      publish(`society/${identity!.societyId}/device/${identity!.id}/events`, {
        type: 'STATE_CHANGED',
        accessPointId: command.accessPointId,
        payload: { state: gateState, commandId: command.commandId },
      });
      log('boom barrier opening');
      await wait(env.motionMs);
    }
    gateState = 'OPEN';
    log('boom barrier open');
  } else if (command.type === 'CLOSE') {
    if (gateState === 'CLOSED') {
      sendAck(command, 'EXECUTED');
      return;
    }
    if (obstructionActive) {
      log('close motion halted immediately: obstruction safety beam tripped');
      gateState = 'STOPPED';
      sendAck(command, 'FAILED');
      return;
    }
    if (gateState !== 'CLOSING') {
      gateState = 'CLOSING';
      publish(`society/${identity!.societyId}/device/${identity!.id}/events`, {
        type: 'STATE_CHANGED',
        accessPointId: command.accessPointId,
        payload: { state: gateState, commandId: command.commandId },
      });
      log('boom barrier closing');
      await wait(env.motionMs);
    }
    if (obstructionActive) {
      log('barrier reached obstruction during travel; stopping and reverting to OPEN');
      gateState = 'OPEN';
      sendAck(command, 'FAILED');
      return;
    }
    gateState = 'CLOSED';
    log('boom barrier closed');
  } else {
    gateState = 'STOPPED';
    log('gate stopped');
  }
  sendAck(command, 'EXECUTED');
}

function acceptCommand(raw: Buffer): void {
  if (isOffline) {
    log('cloud MQTT command ignored: controller is operating in bounded offline mode');
    return;
  }
  let command: SignedCommand;
  try {
    command = JSON.parse(raw.toString('utf8')) as SignedCommand;
  } catch {
    log('ignored non-JSON command');
    return;
  }
  if (typeof command.commandId !== 'string' || typeof command.signature !== 'string') {
    log('ignored malformed command');
    return;
  }
  if (!verifySignature(command)) {
    log(`refused command ${command.commandId.slice(0, 8)}: bad signature`);
    return;
  }
  if (!identity || command.deviceId !== identity.id) {
    log('refused command for another device');
    return;
  }
  if (!assignedGate(command.accessPointId)) {
    log(`refused command for unassigned gate ${command.accessPointId}`);
    return;
  }
  if (new Date(command.expiresAt).getTime() <= Date.now()) {
    log(`refused expired command ${command.commandId.slice(0, 8)}`);
    sendAck(command, 'FAILED');
    return;
  }
  if (!['OPEN', 'CLOSE', 'STOP'].includes(command.type)) {
    log('refused unknown command type');
    return;
  }
  log(`command ${command.type} for ${assignedGate(command.accessPointId)} (${command.commandId.slice(0, 8)})`);
  operation = operation
    .then(() => moveGate(command))
    .catch((error) => log(`execution failed: ${String(error)}`));
}

function connectMqtt(): void {
  if (!env.mqttUrl) {
    log('MQTT_URL is not set; gate commands cannot be received (HTTP verification still works)');
    return;
  }
  mqttClient = mqtt.connect(env.mqttUrl, {
    clientId: `societyos-sim-${env.deviceToken.slice(-8)}-${crypto.randomBytes(3).toString('hex')}`,
    username: env.mqttUsername,
    password: env.mqttPassword,
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 5000,
  });
  mqttClient.on('connect', () => {
    if (!identity) return;
    const topic = `society/${identity.societyId}/device/${identity.id}/commands`;
    mqttClient!.subscribe(topic, { qos: 1 }, (error) => {
      if (error) log(`subscribe failed: ${error.message}`);
      else log(`listening for signed commands on ${topic}`);
    });
  });
  mqttClient.on('message', (topic, payload) => {
    if (!identity) return;
    if (!topic.endsWith(`/device/${identity.id}/commands`)) return;
    acceptCommand(payload);
  });
  mqttClient.on('error', (error) => log(`MQTT error: ${error.message}`));
  mqttClient.on('reconnect', () => log('MQTT reconnecting'));
}

async function heartbeat(): Promise<void> {
  if (!identity) return;
  if (isOffline) {
    log('heartbeat suppressed: controller is in offline mode');
    return;
  }
  const payload = {
    online: true,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    rssi: -58,
    meta: { gateState, firmware: identity.firmware, simulator: true },
  };
  try {
    await api('/api/v1/device-api/health', { method: 'POST', body: JSON.stringify(payload) });
  } catch (error) {
    log(`heartbeat rejected: ${String(error)}`);
  }
  publish(`society/${identity.societyId}/device/${identity.id}/health`, payload);
}

function startHeartbeat(): void {
  void heartbeat();
  const timer = setInterval(() => void heartbeat(), env.heartbeatSeconds * 1000);
  timer.unref();
}

function selectGate(): { id: string; name: string } | null {
  if (!identity) return null;
  if (env.gateId) {
    const linked = identity.accessPoints.find((link) => link.accessPoint.id === env.gateId);
    if (linked) return linked.accessPoint;
  }
  return identity.accessPoints[0]?.accessPoint ?? null;
}

interface CachedCredential {
  passId?: string;
  credentialHash: string;
  kind: 'PIN' | 'QR' | 'BIOMETRIC';
  visitorName: string;
  flatNumber: string;
  validFrom: number;
  validUntil: number;
  maxUses: number;
  usedCount: number;
}

interface QueuedEvent {
  sequence: number;
  accessPointId: string;
  credentialType: string;
  decision: 'AUTHORIZED' | 'DENIED';
  reasonCode: string;
  timestamp: string;
  passId?: string;
  credentialHash?: string;
}

let isOffline = false;
let eventSequence = 1;
const offlineQueue: QueuedEvent[] = [];
const credentialCache = new Map<string, CachedCredential>();
const revokedHashes = new Set<string>();

const CACHE_FILE = path.join(process.cwd(), '.controller_cache.json');

function persistCache(): void {
  try {
    const data = {
      eventSequence,
      offlineQueue,
      credentials: Array.from(credentialCache.entries()),
      revokedHashes: Array.from(revokedHashes),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Non-fatal if filesystem is restricted
  }
}

const MAX_OFFLINE_BUFFER = 1000;

function enqueueOfflineEvent(event: QueuedEvent): void {
  if (offlineQueue.length >= MAX_OFFLINE_BUFFER) {
    const dropped = offlineQueue.shift();
    log(
      `[BOUNDED QUEUE POLICY] Dropped oldest offline event #${dropped?.sequence} (buffer capacity ${MAX_OFFLINE_BUFFER} reached).`,
    );
  }
  offlineQueue.push(event);
  persistCache();
}

function loadPersistedCache(): boolean {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.eventSequence === 'number') {
        eventSequence = Math.max(eventSequence, parsed.eventSequence);
      }
      if (Array.isArray(parsed.offlineQueue)) {
        offlineQueue.length = 0;
        offlineQueue.push(...parsed.offlineQueue.slice(-MAX_OFFLINE_BUFFER));
      }
      if (Array.isArray(parsed.revokedHashes)) {
        for (const h of parsed.revokedHashes) {
          revokedHashes.add(h);
        }
      }
      if (Array.isArray(parsed.credentials)) {
        credentialCache.clear();
        for (const [key, val] of parsed.credentials) {
          if (!revokedHashes.has(key)) {
            credentialCache.set(key, val);
          }
        }
        log(`[PERSISTENCE] Restored ${credentialCache.size} credentials and ${offlineQueue.length} queued events from disk.`);
        return true;
      }
    }
  } catch (err) {
    log(`[PERSISTENCE] Cache recovery warning: ${String(err)}`);
  }
  return false;
}

function populateInitialCache(): void {
  const hasPersisted = loadPersistedCache();
  if (hasPersisted) {
    return;
  }

  // Sample offline-usable PIN (HMAC hashed)
  const pinHash = hashCredential('888999');
  credentialCache.set(pinHash, {
    passId: '00000000-0000-4000-a000-000000000001',
    credentialHash: pinHash,
    kind: 'PIN',
    visitorName: 'Offline Test Pass',
    flatNumber: '101',
    validFrom: Date.now() - 3600_000,
    validUntil: Date.now() + 86400_000,
    maxUses: 3,
    usedCount: 0,
  });
}

async function pullEdgeCache(): Promise<void> {
  try {
    const res = await fetch(`${env.apiUrl}/api/v1/device-api/edge-sync`, {
      headers: { authorization: `Bearer ${env.deviceToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        credentials?: CachedCredential[];
        revokedHashes?: string[];
      };
      if (Array.isArray(data.credentials)) {
        const activeHashes = new Set(data.credentials.map((c) => c.credentialHash));
        const revokedList = Array.isArray(data.revokedHashes) ? data.revokedHashes : [];
        for (const h of revokedList) {
          revokedHashes.add(h);
        }

        // Evict revoked credentials or stale entries no longer returned as active
        for (const [key] of credentialCache.entries()) {
          if (revokedHashes.has(key) || !activeHashes.has(key)) {
            credentialCache.delete(key);
          }
        }

        for (const cred of data.credentials) {
          if (!revokedHashes.has(cred.credentialHash)) {
            const existing = credentialCache.get(cred.credentialHash);
            credentialCache.set(cred.credentialHash, {
              ...cred,
              usedCount: existing ? Math.max(existing.usedCount, cred.usedCount) : cred.usedCount,
            });
          }
        }
        persistCache();
        log(
          `[EDGE SYNC] Loaded ${data.credentials.length} credentials into local controller cache (purged stale/revoked entries).`,
        );
      }
    }
  } catch (err) {
    log(`[EDGE SYNC] Edge sync endpoint unavailable (${String(err)}). Local offline cache active.`);
  }
}

function verifyOffline(kind: 'PIN' | 'QR' | 'BIOMETRIC', credential: string): void {
  const gate = selectGate();
  if (!gate) {
    log('[OFFLINE] no gate assigned');
    return;
  }
  const lookupKey = kind === 'BIOMETRIC' ? credential : hashCredential(credential);
  const now = Date.now();
  let decision: 'AUTHORIZED' | 'DENIED' = 'DENIED';
  let reason = 'INVALID_CREDENTIAL';

  if (revokedHashes.has(lookupKey)) {
    decision = 'DENIED';
    reason = 'PASS_REVOKED';
  } else {
    const cached = credentialCache.get(lookupKey);
    if (cached) {
      if (now < cached.validFrom) {
        reason = 'PASS_SCHEDULED';
      } else if (now > cached.validUntil) {
        reason = 'PASS_EXPIRED';
      } else if (cached.usedCount >= cached.maxUses) {
        reason = 'PASS_EXHAUSTED';
      } else {
        decision = 'AUTHORIZED';
        reason = 'VALID_OFFLINE_CACHE';
        cached.usedCount += 1;
      }
    }
  }

  const cached = credentialCache.get(lookupKey);
  const event: QueuedEvent = {
    sequence: eventSequence++,
    accessPointId: gate.id,
    credentialType: kind,
    decision,
    reasonCode: reason,
    timestamp: new Date().toISOString(),
    passId: cached?.passId,
    credentialHash: cached?.credentialHash || (cached || revokedHashes.has(lookupKey) ? lookupKey : undefined),
  };
  enqueueOfflineEvent(event);

  log(
    `[OFFLINE EVAL #${event.sequence}] ${decision} at ${gate.name} · ${reason} (${offlineQueue.length} events queued)`,
  );

  if (decision === 'AUTHORIZED') {
    void moveGate({
      commandId: `offline-${event.sequence}`,
      deviceId: identity?.id || '',
      accessPointId: gate.id,
      type: 'OPEN',
      nonce: String(Date.now()),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      signature: '',
    });
  }
}

async function syncOfflineQueue(): Promise<void> {
  if (offlineQueue.length === 0) {
    log('Offline queue is clear. Nothing to sync.');
    return;
  }
  log(`Synchronizing ${offlineQueue.length} offline buffered events with cloud API...`);
  const drained = [...offlineQueue];
  const BATCH_SIZE = 500;
  const successfullySynced = new Set<number>();

  for (let i = 0; i < drained.length; i += BATCH_SIZE) {
    const chunk = drained.slice(i, i + BATCH_SIZE);
    let batchOk = false;
    try {
      const res = await fetch(`${env.apiUrl}/api/v1/device-api/sync-offline`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.deviceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ events: chunk }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        chunk.forEach((ev) => successfullySynced.add(ev.sequence));
        log(`Cloud ledger batch resynchronization complete for batch of ${chunk.length} events.`);
        batchOk = true;
      } else {
        log(`Batch sync returned HTTP ${res.status}, attempting fallback per-event ingestion for chunk...`);
      }
    } catch (err) {
      log(`Batch sync failed (${String(err)}), attempting fallback per-event ingestion...`);
    }

    if (!batchOk) {
      for (const event of chunk) {
        try {
          const res = await fetch(`${env.apiUrl}/api/v1/device-api/events`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${env.deviceToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              type: 'STATE_CHANGED',
              accessPointId: event.accessPointId,
              sequence: event.sequence,
              payload: {
                offlineDecision: event.decision,
                reasonCode: event.reasonCode,
                credentialType: event.credentialType,
                bufferedAt: event.timestamp,
              },
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            successfullySynced.add(event.sequence);
            log(`  -> Synced sequence #${event.sequence}: ${event.decision} (${event.reasonCode}) to cloud ledger`);
          } else {
            log(`  -> Failed sequence #${event.sequence} (HTTP ${res.status}); preserving in offline queue`);
          }
        } catch {
          log(`  -> Synced sequence #${event.sequence}: network failure (offline queue preserved)`);
        }
      }
    }
  }

  // Remove only events that were confirmed synced
  const remaining = offlineQueue.filter((ev) => !successfullySynced.has(ev.sequence));
  offlineQueue.length = 0;
  offlineQueue.push(...remaining);
  persistCache();
  log(`Cloud ledger resynchronization attempt complete. ${successfullySynced.size} synced, ${offlineQueue.length} remaining in local queue.`);
}

async function verifyCredential(kind: 'PIN' | 'QR' | 'BIOMETRIC', credential: string): Promise<void> {
  if (isOffline) {
    verifyOffline(kind, credential);
    return;
  }
  const gate = selectGate();
  if (!gate) {
    log('no gate is assigned to this controller');
    return;
  }
  try {
    const response = await fetch(`${env.apiUrl}/api/v1/access/verify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.deviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accessPointId: gate.id,
        credentialType: kind,
        credential,
        requestId: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as VerifyResponse & { message?: string };
    if (!response.ok) {
      log(`verification failed: ${body.message ?? response.status}`);
      return;
    }
    log(
      `${body.decision === 'AUTHORIZED' ? 'ALLOW' : 'DENY'} at ${gate.name} · ${body.reasonCode}${
        body.commandId ? ` · command ${body.commandId.slice(0, 8)}` : ''
      }`,
    );
  } catch (error) {
    log(`cloud verification unreachable (${String(error)}). Falling back to bounded offline policy.`);
    verifyOffline(kind, credential);
  }
}

function startConsole(): void {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.setPrompt('sim> ');
  console.log('\nCommands: pin <code> | qr <token> | bio <token> | sync | offline | online | emergency | obstruct [on|off] | fault [on|off] | cache | queue | hp | state | help | quit\n');
  prompt();
  rl.prompt();

  rl.on('line', (line) => {
    const [rawCommand, ...rest] = line.trim().split(/\s+/);
    const argument = rest.join(' ').trim();
    const command = (rawCommand || '').toLowerCase();
    switch (command) {
      case 'pin':
        if (!/^\d{4,8}$/.test(argument)) log('usage: pin 123456');
        else void verifyCredential('PIN', argument);
        break;
      case 'qr':
        if (!argument) log('usage: qr <token>');
        else void verifyCredential('QR', argument);
        break;
      case 'bio':
        if (!argument) log('usage: bio <token>');
        else void verifyCredential('BIOMETRIC', argument);
        break;
      case 'offline':
        isOffline = true;
        log('[SIMULATOR] Disconnected from cloud. Operating in Bounded Offline Mode.');
        break;
      case 'online':
        isOffline = false;
        log('[SIMULATOR] Connected to cloud. Draining offline event queue.');
        void syncOfflineQueue();
        break;
      case 'emergency':
      case 'egress': {
        const gate = selectGate();
        if (!gate) {
          log('no gate assigned');
          break;
        }
        gateState = 'OPEN';
        log(`[EMERGENCY EGRESS] Gate ${gate.name} forced OPEN for emergency/fire release.`);
        const event: QueuedEvent = {
          sequence: eventSequence++,
          accessPointId: gate.id,
          credentialType: 'MANUAL_EMERGENCY',
          decision: 'AUTHORIZED',
          reasonCode: 'EMERGENCY_OVERRIDE',
          timestamp: new Date().toISOString(),
        };
        enqueueOfflineEvent(event);
        if (!isOffline) {
          void syncOfflineQueue();
        }
        break;
      }
      case 'obstruct':
        obstructionActive = argument === 'off' ? false : argument === 'on' ? true : !obstructionActive;
        log(`[SENSOR] Vehicle loop / safety beam obstruction is now: ${obstructionActive ? 'ACTIVE (BLOCKED)' : 'CLEAR'}`);
        if (obstructionActive && gateState === 'CLOSING') {
          gateState = 'STOPPED';
          log('[SENSOR SAFETY INTERLOCK] Gate motion STOPPED due to active obstruction.');
        }
        break;
      case 'fault':
        sensorFault = argument === 'off' ? false : argument === 'on' ? true : !sensorFault;
        gateState = sensorFault ? 'FAULT' : 'CLOSED';
        log(`[HARDWARE] Sensor/motor fault status: ${sensorFault ? 'FAULT TRIGGERED' : 'RESOLVED/NORMAL'}`);
        break;
      case 'cache':
        log(`Local Edge Cache: ${credentialCache.size} templates/passes stored`);
        credentialCache.forEach((val, key) => log(`  - [${val.kind}] ${key}: ${val.visitorName} (uses: ${val.usedCount}/${val.maxUses})`));
        break;
      case 'queue':
        log(`Offline Queue Depth: ${offlineQueue.length} events waiting`);
        offlineQueue.forEach((ev) => log(`  - Seq #${ev.sequence}: ${ev.decision} (${ev.reasonCode}) at ${ev.timestamp}`));
        break;
      case 'hp':
        void heartbeat();
        log('heartbeat sent');
        break;
      case 'state':
        log(`gate state ${gateState}; network: ${isOffline ? 'OFFLINE' : 'ONLINE'}; obstruction: ${obstructionActive ? 'ACTIVE' : 'CLEAR'}; fault: ${sensorFault ? 'YES' : 'NO'}; ${identity?.accessPoints.length ?? 0} gates assigned`);
        break;
      case 'sync':
        log('[SIMULATOR] Pulling latest edge credentials and syncing offline event queue...');
        void pullEdgeCache();
        void syncOfflineQueue();
        break;
      case 'help':
        console.log('Commands: pin <code> | qr <token> | bio <token> | sync | offline | online | emergency | obstruct [on|off] | fault [on|off] | cache | queue | hp | state | help | quit');
        break;
      case 'quit':
      case 'exit':
        rl.close();
        return;
      case '':
        break;
      default:
        log(`unknown command "${command}" — type help`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    log('shutting down');
    mqttClient?.end(true);
    process.exit(0);
  });
}

async function main(): Promise<void> {
  log(`starting virtual controller against ${env.apiUrl}`);
  populateInitialCache();
  identity = await loadIdentity();
  await pullEdgeCache();
  connectMqtt();
  startHeartbeat();
  startConsole();
}

process.on('SIGINT', () => {
  mqttClient?.end(true);
  process.exit(0);
});

void main().catch((error) => {
  console.error(`Simulator failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
