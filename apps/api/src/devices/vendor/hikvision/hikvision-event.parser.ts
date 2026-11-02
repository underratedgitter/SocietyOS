import { VendorBiometricEvent, VerifyMethod } from '../vendor-event';
import { ParseResult } from '../parse-result';

/**
 * Hikvision ISAPI "HTTP listening" access-control event parser. Pure: no Nest, no DB.
 *
 * Sources: Hikvision ISAPI access-control event notification (`AccessControllerEvent`) and the
 * Device Network SDK minor-event constants (MINOR_*). This file was written without live access to
 * the vendor portal, so values are graded:
 *
 * CONFIDENT (stable for many firmware generations):
 *   majorEventType 5 = access-control "Event" class
 *   subEventType   1  MINOR_LEGAL_CARD_PASS
 *   subEventType  75  MINOR_FACE_VERIFY_PASS         (0x4B)
 *   subEventType  76  MINOR_FACE_VERIFY_FAIL         (0x4C)
 *   subEventType  97  MINOR_FINGERPRINT_COMPARE_PASS (0x61)
 *   subEventType  98  MINOR_FINGERPRINT_COMPARE_FAIL (0x62)
 *
 * UNCONFIRMED (recalled from the SDK header ordering; verify against the target firmware. A wrong
 * entry only mislabels the method/decision of a scan the terminal already decided):
 *   77/78   face+fingerprint pass/fail              (0x4D/0x4E)
 *   80/81   face+password pass/fail                 (0x50/0x51)
 *   83/84   face+card pass/fail                     (0x53/0x54)
 *   86/87   face+password+fingerprint pass/fail     (0x56/0x57)
 *   89/90   face+card+fingerprint pass/fail         (0x59/0x5A)
 *   99/100  card+fingerprint pass/fail              (0x63/0x64)
 *   102/103 card+fingerprint+password pass/fail     (0x66/0x67)
 *   105/106 fingerprint+password pass/fail          (0x69/0x6A)
 * Timeout minor types (79, 82, 85, 88, 91, 101, 104, 107) are deliberately ignored: nobody was
 * matched or mismatched, the attempt just lapsed.
 * Door status, tamper, heartbeat (eventType "heartBeat") and every other minor type are ignored.
 *
 * `currentVerifyMode` is the terminal's *configured* mode (e.g. "cardOrFaceOrFp"), not the factor
 * actually used, so it is never used to derive the method.
 *
 * Success response: the device needs HTTP 200; a body is optional. A well-formed ISAPI
 * ResponseStatus is sent (UNCONFIRMED whether any firmware inspects it).
 */

export interface HikvisionMultipartPart {
  /** Multipart field name, e.g. "event_log" or "AccessControllerEvent", "Picture". */
  name: string;
  mimeType?: string;
  data: Buffer | string;
}

interface SubEventRule {
  method: VerifyMethod;
  matched: boolean;
}

const SUB_EVENTS: ReadonlyMap<number, SubEventRule> = new Map<number, SubEventRule>([
  [1, { method: 'CARD', matched: true }],
  [75, { method: 'FACE', matched: true }],
  [76, { method: 'FACE', matched: false }],
  [77, { method: 'FACE', matched: true }],
  [78, { method: 'FACE', matched: false }],
  [80, { method: 'FACE', matched: true }],
  [81, { method: 'FACE', matched: false }],
  [83, { method: 'FACE', matched: true }],
  [84, { method: 'FACE', matched: false }],
  [86, { method: 'FACE', matched: true }],
  [87, { method: 'FACE', matched: false }],
  [89, { method: 'FACE', matched: true }],
  [90, { method: 'FACE', matched: false }],
  [97, { method: 'FINGERPRINT', matched: true }],
  [98, { method: 'FINGERPRINT', matched: false }],
  [99, { method: 'FINGERPRINT', matched: true }],
  [100, { method: 'FINGERPRINT', matched: false }],
  [102, { method: 'FINGERPRINT', matched: true }],
  [103, { method: 'FINGERPRINT', matched: false }],
  [105, { method: 'FINGERPRINT', matched: true }],
  [106, { method: 'FINGERPRINT', matched: false }],
]);

const ACCESS_CONTROL_MAJOR = 5;
const EVENT_PART_NAME = /^(AccessControllerEvent|event_log)$/i;
const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,10}$/.test(value.trim())) return Number(value);
  return null;
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** ISO-8601 with an explicit offset; offset-less times are rejected because the zone is unknowable. */
function parseDateTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!OFFSET_SUFFIX.test(text)) return null;
  const normalized = text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Converts one decoded notification object. Returns null when it is not a usable verification event. */
function toEvent(payload: unknown): VendorBiometricEvent | null {
  if (!isObject(payload)) return null;
  if (typeof payload.eventType !== 'string' || payload.eventType.toLowerCase() !== 'accesscontrollerevent') {
    return null;
  }
  const detail = payload.AccessControllerEvent;
  if (!isObject(detail)) return null;

  const major = asInt(detail.majorEventType);
  if (major !== null && major !== ACCESS_CONTROL_MAJOR) return null;
  const sub = asInt(detail.subEventType);
  if (sub === null) return null;
  const rule = SUB_EVENTS.get(sub);
  if (!rule) return null;

  const deviceUserId = asId(detail.employeeNoString) ?? asId(detail.employeeNo);
  if (!deviceUserId) return null; // e.g. a stranger's face: nothing to attribute the scan to
  const occurredAt = parseDateTime(payload.dateTime);
  if (!occurredAt) return null;

  const serial = asId(detail.serialNo);
  return {
    deviceUserId,
    method: rule.method,
    occurredAt,
    matched: rule.matched,
    ...(serial ? { vendorEventId: serial } : {}),
  };
}

function collect(payloads: unknown[]): ParseResult {
  const events: VendorBiometricEvent[] = [];
  let ignored = 0;
  for (const payload of payloads) {
    const event = toEvent(payload);
    if (event) events.push(event);
    else ignored += 1;
  }
  return { events, ignored };
}

function decode(data: Buffer | string): unknown {
  return JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
}

/** Plain JSON body: raw text, or the object an upstream body parser already produced. */
export function parseHikvisionJson(body: unknown): ParseResult {
  try {
    const decoded: unknown = typeof body === 'string' || Buffer.isBuffer(body) ? decode(body) : body;
    return collect(Array.isArray(decoded) ? decoded : [decoded]);
  } catch {
    return { events: [], ignored: 1 };
  }
}

/**
 * multipart/form-data body, already split into parts. Only the JSON event part(s) are decoded;
 * picture parts (and anything else) are dropped without being read, so biometric images are
 * never retained by this module.
 */
export function parseHikvisionMultipart(parts: readonly HikvisionMultipartPart[]): ParseResult {
  const payloads: unknown[] = [];
  let malformed = 0;
  for (const part of parts) {
    const mime = part.mimeType?.toLowerCase() ?? '';
    if (mime.startsWith('image/')) continue;
    if (!EVENT_PART_NAME.test(part.name) && !mime.includes('json')) continue;
    try {
      payloads.push(decode(part.data));
    } catch {
      malformed += 1;
    }
  }
  const result = collect(payloads);
  return { events: result.events, ignored: result.ignored + malformed };
}
