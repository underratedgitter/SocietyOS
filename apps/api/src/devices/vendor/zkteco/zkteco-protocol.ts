import { DeviceSyncCommandKind } from '@prisma/client';
import { DEVICE_USER_ID_PATTERN, VendorBiometricEvent, VerifyMethod } from '../vendor-event';

/**
 * Pure helpers for the ZKTeco ADMS ("iclock") PUSH protocol. No Nest, no DB.
 *
 * Documentation caveats (the PUSH SDK spec is only distributed to partners and OEM firmware
 * differs):
 *  - ATTLOG columns beyond PIN, time, status, verify mode and workcode are firmware specific and
 *    ignored.
 *  - The verify-mode numbering below is the commonly observed one; OEMs may remap it, so
 *    anything unrecognised becomes UNKNOWN rather than being guessed.
 */

const VERIFY_MODE_METHODS: Readonly<Record<string, VerifyMethod>> = {
  '1': 'FINGERPRINT',
  '15': 'FACE',
  '4': 'CARD',
  '3': 'PIN',
  '25': 'PALM',
};

export function verifyModeToMethod(mode: string): VerifyMethod {
  return VERIFY_MODE_METHODS[mode.trim()] ?? 'UNKNOWN';
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an invalid IANA name, which surfaces misconfigured societies early.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset (ms) of `timeZone` from UTC at the given instant: local wall time minus UTC. */
function zoneOffsetMs(timeZone: string, instantMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Converts a device wall-clock string (`YYYY-MM-DD HH:mm:ss`) in an IANA zone to a UTC Date, or
 * null when malformed. DST: in the repeated autumn hour the earlier instant is used; a wall time
 * skipped by spring-forward is read with the pre-transition offset (so 02:30 becomes 03:30).
 */
export function deviceLocalTimeToUtc(local: string, timeZone: string): Date | null {
  const match = LOCAL_TIME.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(wall);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  const offsetBefore = zoneOffsetMs(timeZone, wall - DAY_MS);
  const offsetAfter = zoneOffsetMs(timeZone, wall + DAY_MS);
  const valid = [offsetBefore, offsetAfter]
    .map((offset) => wall - offset)
    .filter((candidate) => zoneOffsetMs(timeZone, candidate) === wall - candidate);
  if (valid.length === 0) return new Date(wall - offsetBefore);
  return new Date(Math.min(...valid));
}

export interface AttlogParseResult {
  events: VendorBiometricEvent[];
  /** Non-empty lines received, including skipped ones; used for the `OK: <n>` reply. */
  received: number;
  skipped: number;
}

/** Parses an ATTLOG POST body: one tab-separated record per line. Bad lines are skipped. */
export function parseAttlog(body: string, timeZone: string): AttlogParseResult {
  const events: VendorBiometricEvent[] = [];
  let received = 0;
  let skipped = 0;
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    received += 1;
    // Only tab separation is supported: the timestamp itself contains a space.
    const fields = rawLine.split('\t');
    const pin = fields[0]?.trim() ?? '';
    const time = fields[1]?.trim() ?? '';
    if (fields.length < 2 || !DEVICE_USER_ID_PATTERN.test(pin)) {
      skipped += 1;
      continue;
    }
    const occurredAt = deviceLocalTimeToUtc(time, timeZone);
    if (!occurredAt) {
      skipped += 1;
      continue;
    }
    events.push({
      deviceUserId: pin,
      method: verifyModeToMethod(fields[3] ?? ''),
      occurredAt,
      // The terminal only logs a punch after matching on-device.
      matched: true,
      vendorEventId: `${pin}|${time}`,
    });
  }
  return { events, received, skipped };
}

/** Tables posted to /iclock/cdata that this integration acknowledges but does not use. */
export const IGNORED_TABLES: ReadonlySet<string> = new Set(['OPERLOG', 'BIODATA', 'USERINFO']);

export interface SyncCommandLike {
  id: string;
  kind: DeviceSyncCommandKind;
  payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Formats one queued command as a getrequest line, or null when it cannot be expressed safely. */
export function formatCommand(command: SyncCommandLike): string | null {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(command.id)) return null;
  const payload = asRecord(command.payload);
  const userId = typeof payload.deviceUserId === 'string' ? payload.deviceUserId : '';
  switch (command.kind) {
    case 'UPSERT_USER': {
      if (!DEVICE_USER_ID_PATTERN.test(userId)) return null;
      const name = typeof payload.name === 'string' ? payload.name.replace(/[\t\r\n]+/g, ' ').trim() : '';
      return `C:${command.id}:DATA UPDATE USERINFO PIN=${userId}\tName=${name}`;
    }
    case 'DELETE_USER':
      if (!DEVICE_USER_ID_PATTERN.test(userId)) return null;
      return `C:${command.id}:DATA DELETE USERINFO PIN=${userId}`;
    case 'OPEN_DOOR':
      // CONTROL DEVICE <AA><BB><CC><DD> = 01 01 01 05: relay 1, 5 seconds. Argument layout is
      // from community captures of the ADMS spec; confirm on target firmware.
      return `C:${command.id}:CONTROL DEVICE 01010105`;
    default:
      return null;
  }
}

export interface DeviceCommandResult {
  commandId: string;
  success: boolean;
  returnCode: number;
}

/** Parses a devicecmd body (`ID=<id>&Return=<n>&CMD=...`, one result per line). */
export function parseDeviceCommandResults(body: string): DeviceCommandResult[] {
  const results: DeviceCommandResult[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const params = new Map<string, string>();
    for (const pair of line.trim().split('&')) {
      const eq = pair.indexOf('=');
      if (eq > 0) params.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const id = params.get('ID');
    const code = params.get('Return');
    if (!id || code === undefined || !/^-?\d+$/.test(code)) continue;
    const returnCode = Number(code);
    results.push({ commandId: id, success: returnCode === 0, returnCode });
  }
  return results;
}

/**
 * Handshake body for `GET /iclock/cdata`. Ambiguities: `Encrypt` appears as `None` in some
 * captures and `0` in others (we send 0 = no encryption); `ATTLOGStamp=None` asks the terminal
 * to upload every unsent record (resends are harmless: ingest dedupes on `PIN|time`).
 * We deliberately omit TimeZone: the cloud converts using Society.timezone instead.
 */
export function buildHandshake(serial: string): string {
  return [
    `GET OPTION FROM: ${serial}`,
    'ATTLOGStamp=None',
    'OPERLOGStamp=None',
    'ErrorDelay=60',
    'Delay=10',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog',
    'Realtime=1',
    'Encrypt=0',
  ].join('\n');
}
