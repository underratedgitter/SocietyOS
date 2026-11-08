import { SqlSourceConfig } from './config';
import { toIsoWithOffset } from './time';
import { BiometricEvent, DEVICE_USER_ID_PATTERN } from './types';

/** A DB row as returned by the driver layer: dates are already normalised to strings. */
export type Row = Record<string, string | number | boolean | null | undefined>;

export type MapResult = { ok: true; event: BiometricEvent } | { ok: false; reason: string };

const TRUTHY = new Set(['1', 'true', 't', 'y', 'yes']);

function lookup(row: Row, column: string): Row[string] {
  if (column in row) return row[column];
  const lower = column.toLowerCase();
  const key = Object.keys(row).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : row[key];
}

export function mapRow(row: Row, cfg: SqlSourceConfig): MapResult {
  const rawUser = lookup(row, cfg.columns.deviceUserId);
  if (rawUser === null || rawUser === undefined) return { ok: false, reason: 'missing user id' };
  const deviceUserId = String(rawUser).trim();
  if (!DEVICE_USER_ID_PATTERN.test(deviceUserId)) return { ok: false, reason: 'user id has an unsupported format' };

  const rawTime = lookup(row, cfg.columns.occurredAt);
  if (rawTime === null || rawTime === undefined) return { ok: false, reason: 'missing timestamp' };
  const occurredAt = toIsoWithOffset(String(rawTime), cfg.timezone);
  if (!occurredAt) return { ok: false, reason: 'unparseable timestamp' };

  const rawMethod = lookup(row, cfg.columns.method);
  const method = (rawMethod === null || rawMethod === undefined ? undefined : cfg.methodMap[String(rawMethod).trim()]) ?? cfg.defaultMethod;

  let matched = true;
  if (cfg.columns.matched !== true) {
    const raw = lookup(row, cfg.columns.matched);
    matched = raw !== null && raw !== undefined && TRUTHY.has(String(raw).trim().toLowerCase());
  }

  const event: BiometricEvent = { deviceUserId, method, occurredAt, matched };
  if (cfg.columns.vendorEventId) {
    const id = lookup(row, cfg.columns.vendorEventId);
    if (id !== null && id !== undefined && String(id).trim() !== '') event.vendorEventId = String(id).trim().slice(0, 128);
  }
  return { ok: true, event };
}

export function cursorOf(row: Row, cursorColumn: string): string | number | null {
  const v = lookup(row, cursorColumn);
  if (typeof v === 'number' || typeof v === 'string') return v;
  return null;
}
