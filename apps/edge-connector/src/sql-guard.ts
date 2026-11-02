import { ConfigError } from './types';

const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE',
  'CALL', 'GRANT', 'REVOKE', 'INTO', 'REPLACE', 'COPY', 'LOCK', 'SET', 'DECLARE', 'OPENROWSET',
  'OPENQUERY', 'OPENDATASOURCE', 'BULK', 'SHUTDOWN', 'KILL',
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b|\\bxp_\\w+|\\bsp_\\w+`, 'i');

/**
 * Accepts exactly one SELECT (optionally with a leading WITH clause). This is a safety net, not
 * the security boundary: the installer must also use a read-only database login (see README).
 * It is deliberately conservative: comments, backslashes and any second statement are rejected.
 */
export function assertReadOnlySelect(query: string): void {
  const withoutLiterals = query.replace(/'(?:[^']|'')*'/g, '0');
  if (/'/.test(withoutLiterals)) throw new ConfigError('query has an unterminated string literal');
  if (/--|\/\*|\*\/|#/.test(withoutLiterals)) throw new ConfigError('query must not contain comments');
  if (/\\/.test(query)) throw new ConfigError('query must not contain backslashes');
  const body = withoutLiterals.trim().replace(/;\s*$/, '');
  if (body.includes(';')) throw new ConfigError('query must be a single statement');
  if (!/^(select|with)\b/i.test(body)) throw new ConfigError('query must start with SELECT');
  const hit = FORBIDDEN_RE.exec(body);
  if (hit) throw new ConfigError(`query is not read-only (found "${hit[0]}")`);
}

export type Dialect = 'mssql' | 'mysql' | 'postgres';

export interface RewrittenQuery {
  text: string;
  /** Order in which positional parameters must be bound (mysql/postgres). */
  params: ('cursor' | 'limit')[];
}

/**
 * Config queries use `@cursor` and `@limit` for every dialect. mssql keeps named parameters;
 * mysql2 gets `?` and pg gets `$n`. Occurrences inside string literals are left alone.
 */
export function rewritePlaceholders(query: string, dialect: Dialect): RewrittenQuery {
  const params: ('cursor' | 'limit')[] = [];
  const parts = query.split(/('(?:[^']|'')*')/);
  const text = parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/@(cursor|limit)\b/gi, (_m, name: string) => {
        const key = name.toLowerCase() as 'cursor' | 'limit';
        if (dialect === 'mssql') return `@${key}`;
        params.push(key);
        return dialect === 'mysql' ? '?' : `$${params.length}`;
      });
    })
    .join('');
  return { text, params };
}
