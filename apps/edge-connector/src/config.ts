import * as fs from 'fs';
import { Dialect, assertCursorOrderBy, assertReadOnlySelect } from './sql-guard';
import { isValidTimeZone, toIsoWithOffset } from './time';
import { ConfigError, MAX_EVENTS_PER_CALL, VERIFY_METHODS, VerifyMethod } from './types';

export const PLACEHOLDER = 'VERIFY_ON_SITE';

export interface SqlSourceConfig {
  type: 'sql';
  name: string;
  deviceToken: string;
  dialect: Dialect;
  connectionString: string;
  query: string;
  cursorColumn: string;
  cursorType: 'number' | 'datetime';
  initialCursor?: string | number;
  pollIntervalSec: number;
  batchSize: number;
  timezone: string;
  columns: {
    deviceUserId: string;
    occurredAt: string;
    method: string;
    /** `true` = the vendor only logs successful matches; otherwise a column holding 1/0/true/false. */
    matched: true | string;
    vendorEventId?: string;
  };
  /** Vendor code (as string) -> SocietyOS method. Codes not listed map to defaultMethod. */
  methodMap: Record<string, VerifyMethod>;
  defaultMethod: VerifyMethod;
}

export interface BioStar2SourceConfig {
  type: 'biostar2';
  name: string;
  deviceToken: string;
  baseUrl: string;
  loginId: string;
  password: string;
  caFile?: string;
  pollIntervalSec: number;
  batchSize: number;
  /** BioStar 2 door id used for OPEN_DOOR commands (the cloud payload carries none). */
  doorId?: string;
  successCodes: Record<string, VerifyMethod>;
  failureCodes: Record<string, VerifyMethod>;
  cursorOperator: number;
  eventCodeOperator: number;
  initialLookbackHours: number;
}

export type SourceConfig = SqlSourceConfig | BioStar2SourceConfig;

export interface AppConfig {
  cloud: { baseUrl: string; requestTimeoutMs: number };
  stateDir: string;
  sources: SourceConfig[];
}

type Obj = Record<string, unknown>;

class Collector {
  readonly errors: string[] = [];
  add(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(c: Collector, o: Obj, key: string, path: string, required = true): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) c.add(`${path}.${key}`, 'is required');
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    c.add(`${path}.${key}`, 'must be a non-empty string');
    return undefined;
  }
  return v.trim();
}

function int(c: Collector, o: Obj, key: string, path: string, def: number, min: number, max: number): number {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    c.add(`${path}.${key}`, `must be an integer between ${min} and ${max}`);
    return def;
  }
  return v;
}

function secretFromEnv(c: Collector, o: Obj, key: string, path: string, env: NodeJS.ProcessEnv): string {
  const name = str(c, o, key, path);
  if (!name) return '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    c.add(`${path}.${key}`, 'must be the NAME of an environment variable, not the secret itself');
    return '';
  }
  const value = env[name];
  if (!value || value.trim() === '') {
    c.add(`${path}.${key}`, `environment variable ${name} is not set`);
    return '';
  }
  return value.trim();
}

function methodRecord(c: Collector, v: unknown, path: string): Record<string, VerifyMethod> {
  const out: Record<string, VerifyMethod> = {};
  if (!isObj(v)) {
    c.add(path, 'must be an object of vendorCode -> method');
    return out;
  }
  for (const [code, method] of Object.entries(v)) {
    if (code.startsWith('_')) continue;
    if (typeof method !== 'string' || !(VERIFY_METHODS as readonly string[]).includes(method)) {
      c.add(`${path}.${code}`, `must be one of ${VERIFY_METHODS.join(', ')}`);
    } else {
      out[code] = method as VerifyMethod;
    }
  }
  return out;
}

function findPlaceholders(v: unknown, path: string, out: string[]): void {
  if (v === PLACEHOLDER) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => findPlaceholders(x, `${path}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) findPlaceholders(x, `${path}.${k}`, out);
}

export function validateBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return 'must use https (plain http is allowed only for localhost)';
  }
  if (url.username || url.password) return 'must not embed credentials';
  return null;
}

function parseSql(c: Collector, s: Obj, path: string, env: NodeJS.ProcessEnv, name: string): SqlSourceConfig | null {
  const dialect = s.dialect;
  if (dialect !== 'mssql' && dialect !== 'mysql' && dialect !== 'postgres') {
    c.add(`${path}.dialect`, 'must be mssql, mysql or postgres');
  }
  const connectionString = secretFromEnv(c, s, 'connectionStringEnv', path, env);
  const cursorColumn = str(c, s, 'cursorColumn', path);
  const cursorType = s.cursorType === undefined ? 'number' : s.cursorType;
  if (cursorType !== 'number' && cursorType !== 'datetime') c.add(`${path}.cursorType`, 'must be "number" or "datetime"');
  const timezone = str(c, s, 'timezone', path);
  if (timezone && !isValidTimeZone(timezone)) c.add(`${path}.timezone`, 'is not a valid IANA time zone');

  const query = str(c, s, 'query', path);
  if (query && query !== PLACEHOLDER) {
    try {
      assertReadOnlySelect(query);
      if (!/@cursor\b/i.test(query)) c.add(`${path}.query`, 'must reference @cursor');
      if (!/@limit\b/i.test(query)) c.add(`${path}.query`, 'must reference @limit (use TOP (@limit) or LIMIT @limit)');
      if (cursorColumn) {
        assertCursorOrderBy(query, cursorColumn);
      } else if (!/\border\s+by\b/i.test(query)) {
        c.add(`${path}.query`, 'must contain ORDER BY on the cursor column');
      }
    } catch (e) {
      c.add(`${path}.query`, (e as Error).message);
    }
  }

  const initial = s.initialCursor;
  if (initial !== undefined) {
    if (cursorType === 'datetime') {
      if (typeof initial !== 'string' || !toIsoWithOffset(initial, timezone && isValidTimeZone(timezone) ? timezone : 'UTC')) {
        c.add(`${path}.initialCursor`, 'must be a valid datetime string matching the cursor type');
      }
    } else if (cursorType === 'number') {
      const isNum = typeof initial === 'number' && Number.isFinite(initial);
      const isNumStr = typeof initial === 'string' && initial.trim() !== '' && Number.isFinite(Number(initial));
      if (!isNum && !isNumStr) {
        c.add(`${path}.initialCursor`, 'must be a finite number or numeric string matching the cursor type');
      }
    }
  }
  const cols = s.columns;
  let columns: SqlSourceConfig['columns'] | null = null;
  if (!isObj(cols)) {
    c.add(`${path}.columns`, 'is required');
  } else {
    const deviceUserId = str(c, cols, 'deviceUserId', `${path}.columns`);
    const occurredAt = str(c, cols, 'occurredAt', `${path}.columns`);
    const method = str(c, cols, 'method', `${path}.columns`);
    let matched: true | string | undefined;
    if (cols.matched === true) matched = true;
    else matched = str(c, cols, 'matched', `${path}.columns`);
    const vendorEventId = str(c, cols, 'vendorEventId', `${path}.columns`, false);
    if (deviceUserId && occurredAt && method && matched !== undefined) {
      columns = { deviceUserId, occurredAt, method, matched, ...(vendorEventId ? { vendorEventId } : {}) };
    }
  }
  const methodMap = methodRecord(c, s.methodMap ?? {}, `${path}.methodMap`);
  const defaultMethod = s.defaultMethod ?? 'UNKNOWN';
  if (typeof defaultMethod !== 'string' || !(VERIFY_METHODS as readonly string[]).includes(defaultMethod)) {
    c.add(`${path}.defaultMethod`, `must be one of ${VERIFY_METHODS.join(', ')}`);
  }
  if (!dialect || !query || !cursorColumn || !timezone || !columns) return null;
  return {
    type: 'sql',
    name,
    deviceToken: '',
    dialect: dialect as Dialect,
    connectionString,
    query,
    cursorColumn,
    cursorType: cursorType as 'number' | 'datetime',
    ...(typeof initial === 'string' || typeof initial === 'number' ? { initialCursor: initial } : {}),
    pollIntervalSec: int(c, s, 'pollIntervalSec', path, 10, 1, 3600),
    batchSize: int(c, s, 'batchSize', path, 200, 1, MAX_EVENTS_PER_CALL),
    timezone,
    columns,
    methodMap,
    defaultMethod: defaultMethod as VerifyMethod,
  };
}

function parseBioStar(c: Collector, s: Obj, path: string, env: NodeJS.ProcessEnv, name: string): BioStar2SourceConfig | null {
  const baseUrl = str(c, s, 'baseUrl', path);
  if (baseUrl) {
    const problem = validateBaseUrl(baseUrl);
    if (problem) c.add(`${path}.baseUrl`, problem);
  }
  const loginId = secretFromEnv(c, s, 'loginIdEnv', path, env);
  const password = secretFromEnv(c, s, 'passwordEnv', path, env);
  const caFile = str(c, s, 'caFile', path, false);
  if (caFile && !fs.existsSync(caFile)) c.add(`${path}.caFile`, 'file does not exist');
  const doorId = s.doorId === undefined ? undefined : String(s.doorId);
  const codes = isObj(s.eventCodes) ? s.eventCodes : null;
  if (!codes) c.add(`${path}.eventCodes`, 'is required ({ success: {code: method}, failure: {code: method} })');
  const successCodes = codes ? methodRecord(c, codes.success, `${path}.eventCodes.success`) : {};
  const failureCodes = codes ? methodRecord(c, codes.failure ?? {}, `${path}.eventCodes.failure`) : {};
  if (codes && Object.keys(successCodes).length === 0) c.add(`${path}.eventCodes.success`, 'needs at least one code');
  const cursorOperator = int(c, s, 'cursorOperator', path, -1, 0, 100);
  const eventCodeOperator = int(c, s, 'eventCodeOperator', path, -1, 0, 100);
  if (cursorOperator < 0) c.add(`${path}.cursorOperator`, 'is required (BioStar 2 numeric operator for "datetime >=")');
  if (eventCodeOperator < 0) c.add(`${path}.eventCodeOperator`, 'is required (BioStar 2 numeric operator for "in list")');
  if (!baseUrl || !codes) return null;
  return {
    type: 'biostar2',
    name,
    deviceToken: '',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    loginId,
    password,
    ...(caFile ? { caFile } : {}),
    pollIntervalSec: int(c, s, 'pollIntervalSec', path, 10, 1, 3600),
    batchSize: int(c, s, 'batchSize', path, 200, 1, MAX_EVENTS_PER_CALL),
    ...(doorId ? { doorId } : {}),
    successCodes,
    failureCodes,
    cursorOperator,
    eventCodeOperator,
    initialLookbackHours: int(c, s, 'initialLookbackHours', path, 24, 1, 168),
  };
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv): AppConfig {
  const c = new Collector();
  if (!isObj(raw)) throw new ConfigError('config must be a JSON object');

  const placeholders: string[] = [];
  findPlaceholders(raw, '$', placeholders);
  for (const p of placeholders) c.add(p, `still contains ${PLACEHOLDER}; confirm the value on site and replace it`);

  const cloud = isObj(raw.cloud) ? raw.cloud : null;
  if (!cloud) c.add('cloud', 'is required');
  const baseUrl = cloud ? str(c, cloud, 'baseUrl', 'cloud') : undefined;
  if (baseUrl) {
    const problem = validateBaseUrl(baseUrl);
    if (problem) c.add('cloud.baseUrl', problem);
  }
  const requestTimeoutMs = cloud ? int(c, cloud, 'requestTimeoutSec', 'cloud', 15, 1, 120) * 1000 : 15_000;
  const stateDir = typeof raw.stateDir === 'string' && raw.stateDir.trim() ? raw.stateDir.trim() : './state';

  const sources: SourceConfig[] = [];
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    c.add('sources', 'must be a non-empty array');
  } else {
    const names = new Set<string>();
    raw.sources.forEach((s: unknown, i: number) => {
      const path = `sources[${i}]`;
      if (!isObj(s)) return c.add(path, 'must be an object');
      const name = str(c, s, 'name', path);
      if (name && !/^[A-Za-z0-9_-]{1,40}$/.test(name)) c.add(`${path}.name`, 'may only contain letters, digits, _ and -');
      if (name && names.has(name)) c.add(`${path}.name`, 'must be unique');
      if (name) names.add(name);
      const token = secretFromEnv(c, s, 'deviceTokenEnv', path, env);
      let parsed: SourceConfig | null = null;
      if (s.type === 'sql') parsed = parseSql(c, s, path, env, name ?? '');
      else if (s.type === 'biostar2') parsed = parseBioStar(c, s, path, env, name ?? '');
      else c.add(`${path}.type`, 'must be "sql" or "biostar2"');
      if (parsed && name) sources.push({ ...parsed, deviceToken: token });
    });
  }

  if (c.errors.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${c.errors.join('\n  - ')}`);
  }
  return { cloud: { baseUrl: baseUrl!.replace(/\/+$/, ''), requestTimeoutMs }, stateDir, sources };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const file = env.EDGE_CONFIG?.trim();
  if (!file) throw new ConfigError('EDGE_CONFIG must point to the JSON config file');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read EDGE_CONFIG (${file}): ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`EDGE_CONFIG is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw, env);
}
