import { CloudApi } from './cloud';
import { SqlSourceConfig } from './config';
import { Source, submitBatch } from './ingest';
import { Logger } from './log';
import { Row, cursorOf, mapRow } from './mapping';
import { Cursor, StateStore } from './state';
import { wallClockNow } from './time';
import { BiometricEvent, SourceError, SyncCommand } from './types';

export const UNSUPPORTED_FOR_SQL_RESULT =
  'UNSUPPORTED_FOR_SQL_SOURCE: enrol/remove on the terminal or via vendor software';

const MAX_BATCHES_PER_TICK = 20;

export interface SqlClient {
  fetchBatch(cursor: Cursor, limit: number): Promise<Row[]>;
  close(): Promise<void>;
}

/** We never write to the vendor DB, so every command is acked as failed (the server retries unacked ones). */
export async function ackUnsupportedCommands(cloud: CloudApi, commands: SyncCommand[], log: Logger): Promise<void> {
  for (const command of commands) {
    await cloud.ack(command.id, false, UNSUPPORTED_FOR_SQL_RESULT);
    log.info('sync command acked as unsupported', { kind: command.kind });
  }
}

export class SqlSource implements Source {
  readonly name: string;
  readonly pollIntervalSec: number;
  private cursor: Cursor | null;

  constructor(
    private readonly cfg: SqlSourceConfig,
    private readonly db: SqlClient,
    private readonly cloud: CloudApi,
    private readonly state: StateStore,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.name = cfg.name;
    this.pollIntervalSec = cfg.pollIntervalSec;
    this.cursor = state.load();
  }

  private initialCursor(): Cursor {
    if (this.cfg.initialCursor !== undefined) return this.cfg.initialCursor;
    if (this.cfg.cursorType === 'number') return 0;
    // The cloud drops punches older than 7 days anyway; start 24h back instead of replaying history.
    return wallClockNow(this.cfg.timezone, 24 * 3600 * 1000, this.now());
  }

  async tick(signal: AbortSignal): Promise<void> {
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const cursor = this.cursor ?? this.initialCursor();
      const rows = await this.db.fetchBatch(cursor, this.cfg.batchSize);
      if (rows.length === 0) break;

      const events: BiometricEvent[] = [];
      let skipped = 0;
      for (const row of rows) {
        const mapped = mapRow(row, this.cfg);
        if (mapped.ok) events.push(mapped.event);
        else {
          skipped++;
          this.log.warn('row skipped', { reason: mapped.reason });
        }
      }

      const counts = await submitBatch(this.cloud, events, this.log);

      const last = rows[rows.length - 1];
      const next = last ? cursorOf(last, this.cfg.cursorColumn) : null;
      if (next === null) throw new SourceError(`cursorColumn "${this.cfg.cursorColumn}" missing from query results`);
      if (rows.length >= this.cfg.batchSize && next === cursor) {
        throw new SourceError('cursor is stuck: a full batch shares one cursor value; use a unique cursorColumn');
      }
      this.state.save(next);
      this.cursor = next;
      this.log.info('batch forwarded', { source: this.name, rows: rows.length, skipped, ...counts });

      if (rows.length < this.cfg.batchSize || signal.aborted) break;
    }

    if (!signal.aborted) await ackUnsupportedCommands(this.cloud, await this.cloud.pullCommands(), this.log);
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
