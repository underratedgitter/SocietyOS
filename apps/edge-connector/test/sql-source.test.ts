import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { backoffDelayMs } from '../src/backoff';
import { CloudClient } from '../src/cloud';
import { runSources } from '../src/runner';
import { Row } from '../src/mapping';
import { SqlClient, SqlSource, UNSUPPORTED_FOR_SQL_RESULT } from '../src/sql-source';
import { FileStateStore, Cursor } from '../src/state';
import { FakeCloud, MemoryState, row, silentLog, sqlConfig } from './helpers';

class FakeDb implements SqlClient {
  calls: Cursor[] = [];
  closed = false;
  constructor(private readonly rows: Row[]) {}
  async fetchBatch(cursor: Cursor, limit: number): Promise<Row[]> {
    this.calls.push(cursor);
    return this.rows.filter((r) => (r['id'] as number) > (cursor as number)).slice(0, limit);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const live = new AbortController().signal;

function make(rows: Row[], cloud = new FakeCloud(), state = new MemoryState()) {
  const db = new FakeDb(rows);
  return { db, cloud, state, source: new SqlSource(sqlConfig(), db, cloud, state, silentLog) };
}

describe('SqlSource cursor persistence', () => {
  it('saves the cursor only after the cloud accepted the batch', async () => {
    const { cloud, state, source } = make([row(1), row(2), row(3)]);
    cloud.failPost = new Error('network down');
    await assert.rejects(() => source.tick(live), /network down/);
    assert.deepEqual(state.saves, []);

    cloud.failPost = null;
    await source.tick(live);
    assert.deepEqual(state.saves, [2, 3]); // batchSize 2 -> two batches
    assert.equal(cloud.posted.length, 2);
  });

  it('does not advance when the response is malformed (count mismatch)', async () => {
    const http = { request: async () => ({ status: 200, headers: {}, json: { outcomes: [] } }) };
    const state = new MemoryState();
    const source = new SqlSource(sqlConfig(), new FakeDb([row(1)]), new CloudClient(http, 'https://c', 't'), state, silentLog);
    await assert.rejects(() => source.tick(live), /outcome count/);
    assert.deepEqual(state.saves, []);
  });

  it('resumes from the stored cursor', async () => {
    const { db } = make([row(1), row(2), row(3)], new FakeCloud(), new MemoryState(2));
    const cloud = new FakeCloud();
    const s = new SqlSource(sqlConfig(), db, cloud, new MemoryState(2), silentLog);
    await s.tick(live);
    assert.equal(cloud.posted.flat().length, 1);
  });

  it('fails fast when a full batch cannot advance the cursor', async () => {
    const stuck: Row[] = [{ ...row(0) }, { ...row(0) }];
    const db: SqlClient = { fetchBatch: async () => stuck, close: async () => undefined };
    const s = new SqlSource(sqlConfig(), db, new FakeCloud(), new MemoryState(0), silentLog);
    await assert.rejects(() => s.tick(live), /stuck/);
  });
});

describe('SqlSource outcomes', () => {
  it('advances over RECORDED, DUPLICATE and REJECTED, logging rejections without retry', async () => {
    const { cloud, state, source } = make([row(1, '101'), row(2, '102')]);
    cloud.respond = () => [
      { status: 'DUPLICATE', dedupeKey: 'a' },
      { status: 'REJECTED', dedupeKey: 'b', reason: 'UNKNOWN_DEVICE_USER' },
    ];
    await source.tick(live);
    assert.deepEqual(state.saves, [2]);
    assert.equal(cloud.posted.length, 1);
    const warn = silentLog.lines.find((l) => l.includes('event rejected'));
    assert.ok(warn?.includes('UNKNOWN_DEVICE_USER'));
    assert.ok(!warn?.includes('102'), 'user id must be masked');
  });

  it('advances past rows that cannot be mapped without posting them', async () => {
    const { cloud, state, source } = make([row(1, 'bad id!')]);
    await source.tick(live);
    assert.equal(cloud.posted.length, 0);
    assert.deepEqual(state.saves, [1]);
  });
});

describe('SqlSource sync commands', () => {
  it('acks every command as unsupported and never executes anything', async () => {
    const { cloud, source } = make([]);
    cloud.commands = [
      { id: 'c1', kind: 'UPSERT_USER', payload: { deviceUserId: '5', name: 'Asha' } },
      { id: 'c2', kind: 'DELETE_USER', payload: { deviceUserId: '5' } },
      { id: 'c3', kind: 'OPEN_DOOR', payload: {} },
    ];
    await source.tick(live);
    assert.deepEqual(
      cloud.acks,
      ['c1', 'c2', 'c3'].map((id) => ({ id, success: false, result: UNSUPPORTED_FOR_SQL_RESULT })),
    );
    assert.ok(silentLog.lines.every((l) => !l.includes('Asha')));
  });
});

describe('FileStateStore', () => {
  it('writes atomically and round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
    const store = new FileStateStore(path.join(dir, 's', 'zk.state.json'));
    assert.equal(store.load(), null);
    store.save(42);
    store.save('2026-03-01T09:30:00.000');
    assert.equal(store.load(), '2026-03-01T09:30:00.000');
    assert.deepEqual(fs.readdirSync(path.join(dir, 's')), ['zk.state.json']); // no temp file left
    fs.writeFileSync(path.join(dir, 's', 'zk.state.json'), '{"x":1}');
    assert.throws(() => store.load(), /corrupt/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('runner', () => {
  it('backs off with jitter on failure, resets on success, and closes sources on shutdown', async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let n = 0;
    let closed = false;
    const source = {
      name: 's',
      pollIntervalSec: 5,
      async tick(): Promise<void> {
        n++;
        if (n <= 2) throw new Error('db down');
      },
      async close(): Promise<void> {
        closed = true;
      },
    };
    await runSources([source], controller.signal, silentLog, {
      random: () => 1,
      sleepFn: async (ms) => {
        delays.push(ms);
        if (delays.length === 3) controller.abort();
      },
    });
    assert.deepEqual(delays, [1000, 2000, 5000]);
    assert.ok(closed);
  });

  it('lets the in-flight tick finish after abort', async () => {
    const controller = new AbortController();
    let finished = false;
    const source = {
      name: 's',
      pollIntervalSec: 1,
      async tick(): Promise<void> {
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
      },
      async close(): Promise<void> {},
    };
    await runSources([source], controller.signal, silentLog);
    assert.ok(finished);
  });

  it('backoff is bounded and jittered', () => {
    assert.equal(backoffDelayMs(50, 1000, 60_000, () => 1), 60_000);
    assert.equal(backoffDelayMs(50, 1000, 60_000, () => 0), 30_000);
  });
});
