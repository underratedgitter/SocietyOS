import 'dotenv/config';
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

const env = {
  apiUrl: (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, ''),
  mqttUrl: process.env.MQTT_URL?.trim() || '',
  mqttUsername: process.env.MQTT_USERNAME?.trim() || undefined,
  mqttPassword: process.env.MQTT_PASSWORD || undefined,
  deviceToken: process.env.DEVICE_TOKEN?.trim() || '',
  commandSecret: process.env.COMMAND_SECRET?.trim() || '',
  gateId: process.env.ACCESS_POINT_ID?.trim() || undefined,
  heartbeatSeconds: Number.parseInt(process.env.HEARTBEAT_SECONDS || '30', 10) || 30,
  motionMs: Number.parseInt(process.env.GATE_MOTION_MS || '1500', 10) || 1500,
};

if (!env.deviceToken) {
  console.error('DEVICE_TOKEN is required. Run `pnpm --filter @societyos/api db:seed` and use the printed token.');
  process.exit(1);
}
if (!env.commandSecret) {
  console.error('COMMAND_SECRET is required. Use the secret printed by the seed (or rotated in the admin console).');
  process.exit(1);
}

const startedAt = Date.now();
let gateState: GateState = 'CLOSED';
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
    gateState = 'CLOSED';
    log('boom barrier closed');
  } else {
    gateState = 'STOPPED';
    log('gate stopped');
  }
  sendAck(command, 'EXECUTED');
}

function acceptCommand(raw: Buffer): void {
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

async function verifyCredential(kind: 'PIN' | 'QR' | 'BIOMETRIC', credential: string): Promise<void> {
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
    log(`verification request failed: ${String(error)}`);
  }
}

function startConsole(): void {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.setPrompt('sim> ');
  console.log('\nCommands: pin <code> | qr <token> | bio <token> | hp | state | help | quit\n');
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
      case 'hp':
        void heartbeat();
        log('heartbeat sent');
        break;
      case 'state':
        log(`gate state ${gateState}; ${identity?.accessPoints.length ?? 0} gates assigned`);
        break;
      case 'help':
        console.log('Commands: pin <code> | qr <token> | hp | state | help | quit');
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
  identity = await loadIdentity();
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
