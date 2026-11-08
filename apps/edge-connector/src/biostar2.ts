/**
 * Suprema BioStar 2 REST API source.
 *
 * Endpoints used (names from Suprema's public BioStar 2 API reference):
 *   POST /api/login            body { User: { login_id, password } }  -> `bs-session-id` response header
 *   POST /api/events/search    body { Query: { limit, conditions[], orders[] } }
 *   POST /api/users, PUT /api/users/:id, DELETE /api/users/:id
 *   POST /api/doors/open       body { DoorCollection: { rows: [{ id }] } }
 *
 * UNCONFIRMED (marked VERIFY_ON_SITE in the example config / README, check on the site's server
 * at https://<host>/api-docs): numeric condition operators, event-type codes, the exact
 * request body of user create/update, and the `datetime` / `event_type_id.code` /
 * `user_id.user_id` field paths. Operators and codes are therefore config, never hard-coded.
 */
import { CloudApi } from './cloud';
import { BioStar2SourceConfig } from './config';
import { HttpClient } from './http';
import { Source, submitBatch } from './ingest';
import { Logger } from './log';
import { Cursor, StateStore } from './state';
import { toIsoWithOffset } from './time';
import { BiometricEvent, DEVICE_USER_ID_PATTERN, SourceError, SyncCommand, VerifyMethod } from './types';

export interface BioStarEventRow {
  id: string;
  datetime: string;
  eventCode: string;
  userId: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses an /api/events/search response. Rows that lack id or datetime are dropped. */
export function parseEventSearch(json: unknown): BioStarEventRow[] {
  if (!isObj(json) || !isObj(json.EventCollection)) throw new SourceError('BioStar 2: EventCollection missing in response');
  const rows = json.EventCollection.rows;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) throw new SourceError('BioStar 2: EventCollection.rows is not an array');
  const out: BioStarEventRow[] = [];
  for (const r of rows as unknown[]) {
    if (!isObj(r)) continue;
    const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : null;
    const datetime = typeof r.datetime === 'string' ? r.datetime : null;
    const type = isObj(r.event_type_id) ? r.event_type_id.code : undefined;
    const eventCode = typeof type === 'string' || typeof type === 'number' ? String(type) : null;
    if (!id || !datetime || !eventCode) continue;
    const user = isObj(r.user_id) ? r.user_id.user_id : undefined;
    const userId = typeof user === 'string' || typeof user === 'number' ? String(user) : null;
    out.push({ id, datetime, eventCode, userId });
  }
  return out;
}

export function mapBioStarEvent(
  row: BioStarEventRow,
  cfg: Pick<BioStar2SourceConfig, 'successCodes' | 'failureCodes'>,
): BiometricEvent | null {
  const successMethod = cfg.successCodes[row.eventCode];
  const failureMethod = cfg.failureCodes[row.eventCode];
  const method: VerifyMethod | undefined = successMethod ?? failureMethod;
  if (!method || !row.userId || !DEVICE_USER_ID_PATTERN.test(row.userId)) return null;
  const occurredAt = toIsoWithOffset(row.datetime, 'UTC');
  if (!occurredAt) return null;
  return { deviceUserId: row.userId, method, occurredAt, matched: successMethod !== undefined, vendorEventId: row.id.slice(0, 128) };
}

export class BioStar2Api {
  private session: string | null = null;
  constructor(
    private readonly http: HttpClient,
    private readonly cfg: Pick<BioStar2SourceConfig, 'baseUrl' | 'loginId' | 'password'>,
  ) {}

  async login(): Promise<void> {
    const res = await this.http.request({
      method: 'POST',
      url: `${this.cfg.baseUrl}/api/login`,
      body: { User: { login_id: this.cfg.loginId, password: this.cfg.password } },
    });
    const session = res.headers['bs-session-id'];
    if (res.status !== 200 || !session) throw new SourceError(`BioStar 2 login failed (HTTP ${res.status})`);
    this.session = session;
  }

  /** Calls the API, logging in lazily and once more when the session has expired (HTTP 401). */
  async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.session) await this.login();
      const res = await this.http.request({
        method,
        url: `${this.cfg.baseUrl}${path}`,
        headers: { 'bs-session-id': this.session ?? '' },
        ...(body !== undefined ? { body } : {}),
      });
      if (res.status === 401) {
        this.session = null;
        continue;
      }
      return { status: res.status, json: res.json };
    }
    throw new SourceError('BioStar 2 session rejected after re-login');
  }
}

export interface BioStarCommandResult {
  success: boolean;
  result: string;
}

export async function executeBioStarCommand(
  api: BioStar2Api,
  command: SyncCommand,
  doorId: string | undefined,
): Promise<BioStarCommandResult> {
  const userId = command.payload.deviceUserId;
  const ok = (s: number): boolean => s >= 200 && s < 300;
  switch (command.kind) {
    case 'UPSERT_USER': {
      if (!userId || !DEVICE_USER_ID_PATTERN.test(userId)) return { success: false, result: 'INVALID_PAYLOAD: deviceUserId' };
      const body = { User: { user_id: userId, ...(command.payload.name ? { name: command.payload.name } : {}) } };
      const update = await api.call('PUT', `/api/users/${encodeURIComponent(userId)}`, body);
      if (ok(update.status)) return { success: true, result: 'updated' };
      if (update.status !== 404) return { success: false, result: `BIOSTAR_HTTP_${update.status}` };
      const create = await api.call('POST', '/api/users', body);
      return ok(create.status) ? { success: true, result: 'created' } : { success: false, result: `BIOSTAR_HTTP_${create.status}` };
    }
    case 'DELETE_USER': {
      if (!userId || !DEVICE_USER_ID_PATTERN.test(userId)) return { success: false, result: 'INVALID_PAYLOAD: deviceUserId' };
      const res = await api.call('DELETE', `/api/users/${encodeURIComponent(userId)}`);
      // Already gone is the desired end state.
      return ok(res.status) || res.status === 404 ? { success: true, result: 'deleted' } : { success: false, result: `BIOSTAR_HTTP_${res.status}` };
    }
    case 'OPEN_DOOR': {
      if (!doorId) return { success: false, result: 'NOT_CONFIGURED: set doorId on this source' };
      const res = await api.call('POST', '/api/doors/open', { DoorCollection: { rows: [{ id: doorId }] } });
      return ok(res.status) ? { success: true, result: 'opened' } : { success: false, result: `BIOSTAR_HTTP_${res.status}` };
    }
  }
}

export class BioStar2Source implements Source {
  readonly name: string;
  readonly pollIntervalSec: number;
  private cursor: Cursor | null;

  constructor(
    private readonly cfg: BioStar2SourceConfig,
    private readonly api: BioStar2Api,
    private readonly cloud: CloudApi,
    private readonly state: StateStore,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.name = cfg.name;
    this.pollIntervalSec = cfg.pollIntervalSec;
    this.cursor = state.load();
  }

  private async fetchEvents(since: string): Promise<BioStarEventRow[]> {
    const codes = [...Object.keys(this.cfg.successCodes), ...Object.keys(this.cfg.failureCodes)];
    const res = await this.api.call('POST', '/api/events/search', {
      Query: {
        limit: this.cfg.batchSize,
        conditions: [
          { column: 'datetime', operator: this.cfg.cursorOperator, values: [since] },
          { column: 'event_type_id.code', operator: this.cfg.eventCodeOperator, values: codes },
        ],
        orders: [{ column: 'datetime', descending: false }],
      },
    });
    if (res.status !== 200) throw new SourceError(`BioStar 2 events search failed (HTTP ${res.status})`);
    return parseEventSearch(res.json);
  }

  async tick(signal: AbortSignal): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const since = String(this.cursor ?? new Date(this.now() - this.cfg.initialLookbackHours * 3600_000).toISOString());
      const rows = await this.fetchEvents(since);
      if (rows.length === 0) break;
      const events: BiometricEvent[] = [];
      for (const row of rows) {
        const e = mapBioStarEvent(row, this.cfg);
        if (e) events.push(e);
      }
      const counts = await submitBatch(this.cloud, events, this.log);
      const last = rows[rows.length - 1];
      const next = last ? toIsoWithOffset(last.datetime, 'UTC') : null;
      if (!next) throw new SourceError('BioStar 2 returned an unparseable datetime');
      this.state.save(next);
      this.cursor = next;
      this.log.info('batch forwarded', { source: this.name, rows: rows.length, mapped: events.length, ...counts });
      // The cursor operator is ">=", so a full batch that does not advance would loop forever;
      // already-forwarded events come back as DUPLICATE thanks to vendorEventId.
      if (rows.length < this.cfg.batchSize || next === since || signal.aborted) break;
    }

    if (signal.aborted) return;
    for (const command of await this.cloud.pullCommands()) {
      let outcome: BioStarCommandResult;
      try {
        outcome = await executeBioStarCommand(this.api, command, this.cfg.doorId);
      } catch (e) {
        outcome = { success: false, result: `BIOSTAR_ERROR: ${e instanceof Error ? e.name : 'unknown'}` };
      }
      await this.cloud.ack(command.id, outcome.success, outcome.result);
      this.log.info('sync command executed', { kind: command.kind, success: outcome.success });
    }
  }

  async close(): Promise<void> {
    // No persistent handles: the REST client opens a connection per request.
  }
}
