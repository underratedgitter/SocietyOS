const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Turns a vendor timestamp into ISO 8601. Strings that already carry an offset keep the instant
 * they describe (normalised to Z); wall-clock strings are interpreted in `tz` and get its offset.
 * Returns null when the value is not a parseable timestamp.
 */
export function toIsoWithOffset(value: string, tz: string): string | null {
  const trimmed = value.trim();
  if (HAS_OFFSET.test(trimmed)) {
    const date = new Date(trimmed.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const m = WALL.exec(trimmed);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Number(((frac ?? '0') + '00').slice(0, 3));
  const wallAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (new Date(wallAsUtc).getUTCMonth() !== Number(mo) - 1) return null; // e.g. Feb 31
  // Two passes settle the offset across DST boundaries.
  let offset = offsetMinutes(wallAsUtc, tz);
  offset = offsetMinutes(wallAsUtc - offset * 60_000, tz);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${String(ms).padStart(3, '0')}${formatOffset(offset)}`;
}

/** Wall-clock rendering of a Date's UTC fields (mssql returns datetime columns that way). */
export function wallClockFromUtcFields(date: Date): string {
  return date.toISOString().replace('Z', '');
}

/** Current time in `tz` as a wall-clock string, minus `agoMs`. */
export function wallClockNow(tz: string, agoMs: number, now: number = Date.now()): string {
  const t = now - agoMs;
  return new Date(t + offsetMinutes(t, tz) * 60_000).toISOString().replace('Z', '');
}
