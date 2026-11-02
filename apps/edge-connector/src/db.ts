import * as mssql from 'mssql';
import * as mysql from 'mysql2/promise';
import * as pg from 'pg';
import { SqlSourceConfig } from './config';
import { Row } from './mapping';
import { RewrittenQuery, rewritePlaceholders } from './sql-guard';
import { SqlClient } from './sql-source';
import { Cursor } from './state';
import { wallClockFromUtcFields } from './time';
import { SourceError } from './types';

const QUERY_TIMEOUT_MS = 30_000;
const PG_TIMESTAMP_OID = 1114;

type Raw = Record<string, unknown>;

/**
 * Normalises driver values. Dates become strings: mssql (Tedious, useUTC) returns datetime
 * columns as a Date whose UTC fields are the stored wall-clock time, so those are rendered back
 * as wall-clock text and the configured timezone is applied later in mapping.
 */
export function normalizeRow(raw: Raw, dateAsWallClock: boolean): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value instanceof Date) {
      out[key] = Number.isNaN(value.getTime()) ? null : dateAsWallClock ? wallClockFromUtcFields(value) : value.toISOString();
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourceError(`${label} timed out after ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function bind(rewritten: RewrittenQuery, cursor: Cursor, limit: number): (Cursor | number)[] {
  return rewritten.params.map((p) => (p === 'cursor' ? cursor : limit));
}

class MssqlClient implements SqlClient {
  private pool: mssql.ConnectionPool | null = null;
  constructor(private readonly connectionString: string, private readonly query: string) {}

  async fetchBatch(cursor: Cursor, limit: number): Promise<Row[]> {
    try {
      if (!this.pool) {
        const pool = new mssql.ConnectionPool(this.connectionString);
        await withTimeout(pool.connect(), 'mssql connect');
        this.pool = pool;
      }
      const request = this.pool.request();
      if (typeof cursor === 'number') request.input('cursor', mssql.BigInt, cursor);
      else request.input('cursor', mssql.VarChar(40), cursor);
      request.input('limit', mssql.Int, limit);
      const result = await withTimeout(request.query<Raw>(this.query), 'mssql query');
      return result.recordset.map((r) => normalizeRow(r, true));
    } catch (e) {
      await this.close(); // force a clean reconnect on the next attempt
      throw e;
    }
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.close().catch(() => undefined);
  }
}

class MysqlClient implements SqlClient {
  private readonly pool: mysql.Pool;
  private readonly rewritten: RewrittenQuery;
  constructor(connectionString: string, query: string) {
    this.rewritten = rewritePlaceholders(query, 'mysql');
    this.pool = mysql.createPool({ uri: connectionString, dateStrings: true, connectionLimit: 1, connectTimeout: 15_000 });
  }

  async fetchBatch(cursor: Cursor, limit: number): Promise<Row[]> {
    const [rows] = await withTimeout(this.pool.query(this.rewritten.text, bind(this.rewritten, cursor, limit)), 'mysql query');
    if (!Array.isArray(rows)) throw new SourceError('mysql query did not return rows');
    return (rows as Raw[]).map((r) => normalizeRow(r, false));
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}

class PostgresClient implements SqlClient {
  private readonly pool: pg.Pool;
  private readonly rewritten: RewrittenQuery;
  constructor(connectionString: string, query: string) {
    this.rewritten = rewritePlaceholders(query, 'postgres');
    this.pool = new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 15_000,
      statement_timeout: QUERY_TIMEOUT_MS,
      // `timestamp without time zone` stays raw text so the configured timezone is applied by us, not the host's.
      types: {
        getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
          oid === PG_TIMESTAMP_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
      },
    });
    this.pool.on('error', () => undefined); // idle-client errors surface on the next query
  }

  async fetchBatch(cursor: Cursor, limit: number): Promise<Row[]> {
    const result = await withTimeout(this.pool.query<Raw>(this.rewritten.text, bind(this.rewritten, cursor, limit)), 'postgres query');
    return result.rows.map((r) => normalizeRow(r, false));
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}

export function createSqlClient(cfg: SqlSourceConfig): SqlClient {
  switch (cfg.dialect) {
    case 'mssql':
      return new MssqlClient(cfg.connectionString, cfg.query);
    case 'mysql':
      return new MysqlClient(cfg.connectionString, cfg.query);
    case 'postgres':
      return new PostgresClient(cfg.connectionString, cfg.query);
  }
}
