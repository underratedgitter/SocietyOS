import { HttpClient } from './http';
import { BiometricEvent, CloudError, MAX_EVENTS_PER_CALL, Outcome, SyncCommand } from './types';

const KINDS = new Set(['UPSERT_USER', 'DELETE_USER', 'OPEN_DOOR']);
const STATUSES = new Set(['RECORDED', 'DUPLICATE', 'REJECTED']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface CloudApi {
  postEvents(events: BiometricEvent[]): Promise<Outcome[]>;
  pullCommands(): Promise<SyncCommand[]>;
  ack(commandId: string, success: boolean, result?: string): Promise<void>;
}

export function parseOutcomes(json: unknown, expected: number): Outcome[] {
  if (!isObj(json) || !Array.isArray(json.outcomes)) throw new CloudError('malformed response: outcomes missing');
  if (json.outcomes.length !== expected) {
    throw new CloudError(`outcome count ${json.outcomes.length} does not match ${expected} events sent`);
  }
  return json.outcomes.map((o: unknown): Outcome => {
    if (!isObj(o) || typeof o.status !== 'string' || !STATUSES.has(o.status)) {
      throw new CloudError('malformed response: unknown outcome status');
    }
    const dedupeKey = typeof o.dedupeKey === 'string' ? o.dedupeKey : '';
    if (o.status === 'REJECTED') {
      return { status: 'REJECTED', dedupeKey, reason: typeof o.reason === 'string' ? o.reason : 'unspecified' };
    }
    return { status: o.status as 'RECORDED' | 'DUPLICATE', dedupeKey };
  });
}

export function parseCommands(json: unknown): SyncCommand[] {
  if (!isObj(json) || !Array.isArray(json.commands)) throw new CloudError('malformed response: commands missing');
  const out: SyncCommand[] = [];
  for (const c of json.commands as unknown[]) {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.kind !== 'string' || !KINDS.has(c.kind)) {
      throw new CloudError('malformed response: bad sync command');
    }
    const p = isObj(c.payload) ? c.payload : {};
    out.push({
      id: c.id,
      kind: c.kind as SyncCommand['kind'],
      payload: {
        ...(typeof p.deviceUserId === 'string' ? { deviceUserId: p.deviceUserId } : {}),
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
      },
    });
  }
  return out;
}

export class CloudClient implements CloudApi {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async postEvents(events: BiometricEvent[]): Promise<Outcome[]> {
    if (events.length === 0) return [];
    if (events.length > MAX_EVENTS_PER_CALL) throw new CloudError('batch exceeds 500 events');
    const res = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/api/v1/device-api/biometric-events`,
      headers: this.headers(),
      body: { events },
    });
    if (res.status !== 200 && res.status !== 201) throw new CloudError(`cloud rejected batch with HTTP ${res.status}`);
    return parseOutcomes(res.json, events.length);
  }

  async pullCommands(): Promise<SyncCommand[]> {
    const res = await this.http.request({
      method: 'GET',
      url: `${this.baseUrl}/api/v1/device-api/sync-commands`,
      headers: this.headers(),
    });
    if (res.status !== 200) throw new CloudError(`sync-commands failed with HTTP ${res.status}`);
    return parseCommands(res.json);
  }

  async ack(commandId: string, success: boolean, result?: string): Promise<void> {
    const res = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/api/v1/device-api/sync-commands/${encodeURIComponent(commandId)}/ack`,
      headers: this.headers(),
      body: { success, ...(result !== undefined ? { result: result.slice(0, 500) } : {}) },
    });
    if (res.status !== 204 && res.status !== 200) throw new CloudError(`ack failed with HTTP ${res.status}`);
  }
}
