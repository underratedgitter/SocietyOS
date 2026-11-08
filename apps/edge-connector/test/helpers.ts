import { CloudApi } from '../src/cloud';
import { SqlSourceConfig } from '../src/config';
import { Logger } from '../src/log';
import { Row } from '../src/mapping';
import { Cursor, StateStore } from '../src/state';
import { BiometricEvent, Outcome, SyncCommand } from '../src/types';

export const silentLog: Logger & { lines: string[] } = {
  lines: [],
  info(m) {
    this.lines.push(`info ${m}`);
  },
  warn(m, f) {
    this.lines.push(`warn ${m} ${JSON.stringify(f ?? {})}`);
  },
  error(m) {
    this.lines.push(`error ${m}`);
  },
};

export function sqlConfig(over: Partial<SqlSourceConfig> = {}): SqlSourceConfig {
  return {
    type: 'sql',
    name: 'zk',
    deviceToken: 'tok',
    dialect: 'mssql',
    connectionString: 'Server=x',
    query: 'SELECT TOP (@limit) a FROM t WHERE c > @cursor ORDER BY c',
    cursorColumn: 'id',
    cursorType: 'number',
    pollIntervalSec: 5,
    batchSize: 2,
    timezone: 'Asia/Kolkata',
    columns: { deviceUserId: 'emp_code', occurredAt: 'punch_time', method: 'verify_type', matched: true },
    methodMap: { '1': 'FINGERPRINT', '15': 'FACE' },
    defaultMethod: 'UNKNOWN',
    ...over,
  };
}

export function row(id: number, user = '101', code: string | number = 1): Row {
  return { id, emp_code: user, punch_time: '2026-03-01 09:30:00', verify_type: code };
}

export class MemoryState implements StateStore {
  saves: Cursor[] = [];
  constructor(public value: Cursor | null = null) {}
  load(): Cursor | null {
    return this.value;
  }
  save(c: Cursor): void {
    this.value = c;
    this.saves.push(c);
  }
}

export class FakeCloud implements CloudApi {
  posted: BiometricEvent[][] = [];
  acks: { id: string; success: boolean; result?: string }[] = [];
  commands: SyncCommand[] = [];
  respond: (events: BiometricEvent[]) => Outcome[] = (events) =>
    events.map((_, i) => ({ status: 'RECORDED', dedupeKey: `k${i}` }));
  failPost: Error | null = null;

  async postEvents(events: BiometricEvent[]): Promise<Outcome[]> {
    if (this.failPost) throw this.failPost;
    this.posted.push(events);
    return this.respond(events);
  }
  async pullCommands(): Promise<SyncCommand[]> {
    return this.commands;
  }
  async ack(id: string, success: boolean, result?: string): Promise<void> {
    this.acks.push({ id, success, ...(result !== undefined ? { result } : {}) });
  }
}
