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

/**
 * Validates that the outer query contains an ORDER BY clause with the cursor column
 * ascending as its first ordering key.
 */
export function assertCursorOrderBy(query: string, cursorColumn: string): void {
  const withoutLiterals = query.replace(/'(?:[^']|'')*'/g, '0');
  let depth = 0;
  let lastOuterOrderByIndex = -1;

  for (let i = 0; i < withoutLiterals.length; i++) {
    const ch = withoutLiterals[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const match = withoutLiterals.slice(i).match(/^order\s+by\b/i);
      if (match) {
        lastOuterOrderByIndex = i + match[0].length;
      }
    }
  }

  if (lastOuterOrderByIndex === -1) {
    throw new ConfigError('query must contain ORDER BY on the cursor column');
  }

  let end = withoutLiterals.length;
  depth = 0;
  for (let i = lastOuterOrderByIndex; i < withoutLiterals.length; i++) {
    const ch = withoutLiterals[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === ',' || ch === ';') {
        end = i;
        break;
      }
      const rem = withoutLiterals.slice(i);
      if (/^\b(limit|offset|fetch)\b/i.test(rem)) {
        end = i;
        break;
      }
    }
  }

  const firstKey = withoutLiterals.slice(lastOuterOrderByIndex, end).trim();
  if (!firstKey) {
    throw new ConfigError('query must contain ORDER BY on the cursor column');
  }

  if (/\bdesc\b/i.test(firstKey)) {
    throw new ConfigError(`query must order cursor column "${cursorColumn}" ascending, found DESC`);
  }

  const colExpr = firstKey.replace(/\basc\b/i, '').trim();
  const parts = colExpr.split('.');
  const lastPart = (parts[parts.length - 1] ?? '').trim();
  const cleanCol = lastPart.replace(/^[\["`]|[\s\]"`]+$/g, '').trim();

  if (!/^[A-Za-z0-9_]+$/.test(cleanCol) || cleanCol.toLowerCase() !== cursorColumn.toLowerCase()) {
    throw new ConfigError(`query must order cursor column "${cursorColumn}" ascending as the first ordering key`);
  }
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
