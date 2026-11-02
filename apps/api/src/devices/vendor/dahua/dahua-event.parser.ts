import { VendorBiometricEvent, VerifyMethod } from '../vendor-event';
import { ParseResult } from '../parse-result';

/**
 * Dahua access-control event upload parser (`AccessControl` event). Pure: no Nest, no DB.
 *
 * Accepted shapes: JSON ({"Code":"AccessControl","Data":{...}}, a bare Data object, or an array /
 * {"Events":[...]} of those), the CGI attach format
 * (`Code=AccessControl;action=Pulse;index=0;data={...}`), and flat key=value bodies
 * (`UserID=7&Method=15&Status=1&UTC=1700000000&RecNo=42`, separated by & ; or newlines).
 *
 * Written without live access to the vendor portal, so values are graded:
 *
 * CONFIDENT: field names UserID, Method, Status (1 = success, 0 = failure), UTC (epoch seconds),
 *   RecNo (record number), Code "AccessControl".
 *   Method 2 = card, 8 = fingerprint, 15 = face recognition.
 * UNCONFIRMED (recalled from the access-method enum; verify on the target firmware):
 *   Method 9/10/11 = fingerprint combined with password/card -> reported as FINGERPRINT.
 *   `Time` ("YYYY-MM-DD HH:mm:ss"): assumed device-local wall time with no offset; only used when
 *   UTC is absent, interpreted with `localOffsetMinutes`.
 * Every other Method (password 1, remote 6, exit button 7, ...) is ignored, as are other event
 * codes, rows without UserID, and unparsable rows.
 *
 * Success response: HTTP 200 with body "OK" (UNCONFIRMED whether any firmware inspects it).
 */

export interface DahuaParseOptions {
  /** Offset of the device's local clock from UTC; used only for `Time` values lacking `UTC`. */
  localOffsetMinutes?: number;
}

const METHODS: ReadonlyMap<number, VerifyMethod> = new Map<number, VerifyMethod>([
  [2, 'CARD'],
  [8, 'FINGERPRINT'],
  [9, 'FINGERPRINT'],
  [10, 'FINGERPRINT'],
  [11, 'FINGERPRINT'],
  [15, 'FACE'],
]);

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,12}$/.test(value.trim())) return Number(value);
  return null;
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function parseTime(row: Row, options: DahuaParseOptions): Date | null {
  const utc = asInt(row.UTC);
  if (utc !== null && utc > 0) return new Date(utc * 1000);
  if (typeof row.Time !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(row.Time.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s) - (options.localOffsetMinutes ?? 0) * 60_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toEvent(row: Row, options: DahuaParseOptions): VendorBiometricEvent | null {
  const method = asInt(row.Method);
  const mapped = method === null ? undefined : METHODS.get(method);
  if (!mapped) return null;
  const status = asInt(row.Status);
  if (status !== 0 && status !== 1) return null;
  const deviceUserId = asId(row.UserID);
  if (!deviceUserId) return null;
  const occurredAt = parseTime(row, options);
  if (!occurredAt) return null;
  const recNo = asId(row.RecNo);
  return {
    deviceUserId,
    method: mapped,
    occurredAt,
    matched: status === 1,
    ...(recNo ? { vendorEventId: recNo } : {}),
  };
}

/** Flattens a decoded JSON envelope into rows whose Code (when present) is AccessControl. */
function rowsFrom(decoded: unknown): { rows: Row[]; skipped: number } {
  const rows: Row[] = [];
  let skipped = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRow(node)) {
      skipped += 1;
      return;
    }
    if (Array.isArray(node.Events)) {
      node.Events.forEach(visit);
      return;
    }
    if (typeof node.Code === 'string' && node.Code !== 'AccessControl') {
      skipped += 1;
      return;
    }
    rows.push(isRow(node.Data) ? node.Data : node);
  };
  visit(decoded);
  return { rows, skipped };
}

function parseKeyValue(text: string): Row[] {
  const dataAt = text.search(/\bdata=\s*\{/);
  if (dataAt >= 0) {
    const code = /(?:^|[;&\s])Code=([A-Za-z]+)/.exec(text.slice(0, dataAt))?.[1];
    const json: unknown = JSON.parse(text.slice(text.indexOf('{', dataAt)));
    return [{ ...(isRow(json) ? json : {}), ...(code ? { Code: code } : {}) }];
  }
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row: Row = {};
    for (const pair of line.split(/[&;]/)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      row[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows;
}

/** Accepts the raw body text/Buffer or an already-parsed JSON value. Never throws. */
export function parseDahuaEvents(body: unknown, options: DahuaParseOptions = {}): ParseResult {
  let candidates: Row[];
  let ignored = 0;
  try {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const text = (typeof body === 'string' ? body : body.toString('utf8')).trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        const flat = rowsFrom(JSON.parse(text));
        candidates = flat.rows;
        ignored += flat.skipped;
      } else {
        const rows = parseKeyValue(text);
        candidates = rows.filter((r) => r.Code === undefined || r.Code === 'AccessControl');
        ignored += rows.length - candidates.length;
        if (rows.length === 0) ignored += 1;
      }
    } else {
      const flat = rowsFrom(body);
      candidates = flat.rows;
      ignored += flat.skipped;
    }
  } catch {
    return { events: [], ignored: 1 };
  }

  const events: VendorBiometricEvent[] = [];
  for (const row of candidates) {
    const event = toEvent(row, options);
    if (event) events.push(event);
    else ignored += 1;
  }
  return { events, ignored };
}
