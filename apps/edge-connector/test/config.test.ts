import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config';
import { ConfigError } from '../src/types';
import { assertReadOnlySelect, rewritePlaceholders } from '../src/sql-guard';

const env = { TOK: 'secret-token', DB: 'Server=h;Password=p4ssw0rd' };

function base(over: Record<string, unknown> = {}, cloud: Record<string, unknown> = {}): unknown {
  return {
    cloud: { baseUrl: 'https://api.example.com', ...cloud },
    sources: [
      {
        name: 'zk',
        type: 'sql',
        deviceTokenEnv: 'TOK',
        dialect: 'mssql',
        connectionStringEnv: 'DB',
        query: 'SELECT TOP (@limit) emp_code, punch_time FROM iclock_transaction WHERE id > @cursor ORDER BY id',
        cursorColumn: 'id',
        timezone: 'Asia/Kolkata',
        columns: { deviceUserId: 'emp_code', occurredAt: 'punch_time', method: 'verify_type', matched: true },
        methodMap: { '1': 'FINGERPRINT' },
        ...over,
      },
    ],
  };
}

function errorOf(raw: unknown, e: NodeJS.ProcessEnv = env): string {
  try {
    parseConfig(raw, e);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.message;
  }
  return assert.fail('expected ConfigError');
}

describe('parseConfig', () => {
  it('accepts a valid sql config and resolves secrets from env', () => {
    const cfg = parseConfig(base(), env);
    const src = cfg.sources[0];
    assert.equal(src?.deviceToken, 'secret-token');
    assert.equal(src?.type === 'sql' && src.connectionString, env.DB);
    assert.equal(src?.type === 'sql' && src.batchSize, 200);
  });

  it('rejects non-https cloud URLs except localhost', () => {
    assert.match(errorOf(base({}, { baseUrl: 'http://api.example.com' })), /must use https/);
    assert.doesNotThrow(() => parseConfig(base({}, { baseUrl: 'http://localhost:3000' }), env));
  });

  it('rejects non-SELECT queries', () => {
    for (const q of [
      'DELETE FROM t WHERE id > @cursor',
      'SELECT 1 FROM t WHERE id > @cursor ORDER BY id; DROP TABLE t',
      'SELECT * INTO x FROM t',
      'UPDATE t SET a=1',
    ]) {
      assert.match(errorOf(base({ query: q })), /query/, q);
    }
  });

  it('requires @cursor, @limit and ORDER BY', () => {
    const msg = errorOf(base({ query: 'SELECT a FROM t' }));
    assert.match(msg, /@cursor/);
    assert.match(msg, /@limit/);
    assert.match(msg, /ORDER BY/);
  });

  it('requires ascending cursor ordering as the first outer ordering key', () => {
    for (const order of ['punch_time', 'id DESC', 'punch_time, id', "'ORDER BY id'"]) {
      assert.match(errorOf(base({ query: `SELECT TOP (@limit) * FROM t WHERE id > @cursor ORDER BY ${order}` })), /cursor/);
    }
    assert.doesNotThrow(() => parseConfig(base({ query: 'SELECT TOP (@limit) * FROM t WHERE id > @cursor ORDER BY [id] ASC' }), env));
  });

  it('validates initialCursor against its selected type', () => {
    for (const initialCursor of [42, '2026-04-31T10:00:00Z', 'garbage']) {
      assert.match(errorOf(base({ cursorType: 'datetime', initialCursor })), /initialCursor/);
    }
    for (const initialCursor of ['yesterday', Number.POSITIVE_INFINITY]) {
      assert.match(errorOf(base({ initialCursor })), /initialCursor/);
    }
    assert.doesNotThrow(() => parseConfig(base({ cursorType: 'datetime', initialCursor: '2026-04-30T10:00:00Z' }), env));
    assert.doesNotThrow(() => parseConfig(base({ initialCursor: '42' }), env));
  });

  it('requires secrets to be env var names that are set, never inline', () => {
    assert.match(errorOf(base({ deviceTokenEnv: 'sos_abc.def-123' })), /NAME of an environment variable/);
    assert.match(errorOf(base(), { DB: 'x' }), /TOK is not set/);
  });

  it('rejects bad timezone, batch size and methods', () => {
    const msg = errorOf(base({ timezone: 'Mars/Base', batchSize: 501, methodMap: { '1': 'RETINA' } }));
    assert.match(msg, /IANA/);
    assert.match(msg, /batchSize/);
    assert.match(msg, /methodMap/);
  });

  it('fails on VERIFY_ON_SITE placeholders', () => {
    assert.match(errorOf(base({ dialect: 'VERIFY_ON_SITE' })), /VERIFY_ON_SITE/);
  });

  it('ships examples that refuse to start until verified', () => {
    const dir = path.join(__dirname, '..', 'examples');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 5);
    for (const f of files) {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const e = { ZK_DEVICE_TOKEN: 't', ZK_DB_URL: 'x', ESSL_DEVICE_TOKEN: 't', ESSL_DB_URL: 'x', BIOSTAR_DEVICE_TOKEN: 't',
        BIOSTAR_DB_URL: 'x', BIOSTAR_LOGIN_ID: 'a', BIOSTAR_PASSWORD: 'b', COSEC_DEVICE_TOKEN: 't', COSEC_DB_URL: 'x' };
      assert.match(errorOf(raw, e), /VERIFY_ON_SITE/, f);
    }
  });
});

describe('assertReadOnlySelect', () => {
  it('allows SELECT and WITH, ignoring keywords inside string literals', () => {
    assert.doesNotThrow(() => assertReadOnlySelect("SELECT a FROM t WHERE n = 'delete; drop' AND id > @cursor ORDER BY id;"));
    assert.doesNotThrow(() => assertReadOnlySelect('WITH x AS (SELECT 1 a) SELECT a FROM x'));
  });
  it('rejects comments, stacked statements and writes', () => {
    for (const q of ['SELECT 1 -- x', 'SELECT 1 /* x */', 'SELECT 1; SELECT 2', 'EXEC xp_cmdshell', 'SELECT 1 FROM t FOR UPDATE; ', "SELECT 'a"]) {
      assert.throws(() => assertReadOnlySelect(q), ConfigError, q);
    }
  });
});

describe('rewritePlaceholders', () => {
  const q = "SELECT a FROM t WHERE c > @cursor AND x <> '@cursor' ORDER BY c LIMIT @limit";
  it('maps to positional parameters per dialect', () => {
    assert.deepEqual(rewritePlaceholders(q, 'mysql'), {
      text: "SELECT a FROM t WHERE c > ? AND x <> '@cursor' ORDER BY c LIMIT ?",
      params: ['cursor', 'limit'],
    });
    assert.equal(rewritePlaceholders(q, 'postgres').text, "SELECT a FROM t WHERE c > $1 AND x <> '@cursor' ORDER BY c LIMIT $2");
    assert.equal(rewritePlaceholders(q, 'mssql').text, q);
  });
});
