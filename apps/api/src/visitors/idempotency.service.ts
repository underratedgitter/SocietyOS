import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';

type IdempotencyDb = Pick<Prisma.TransactionClient, 'idempotencyRecord'>;

/** Transaction-scoped lock so concurrent requests with one key run their check-then-write one at a time. */
export async function lockIdempotencyKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('idempotency'), hashtext(${key}))`;
}

/** Returns the live cached response for key, or null when absent or expired. */
export async function readIdempotent<T>(
  db: IdempotencyDb,
  key: string,
  endpoint: string,
  fingerprint: string,
): Promise<T | null> {
  const record = await db.idempotencyRecord.findUnique({ where: { key } });
  if (!record) return null;
  if (record.expiresAt && record.expiresAt <= new Date()) return null;
  if (record.endpoint !== endpoint) {
    throw AppException.conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to another operation');
  }
  if (record.requestHash && record.requestHash !== fingerprint) {
    throw AppException.conflict(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'This idempotency key was already used with different request content',
    );
  }
  return record.responseBody as T;
}

/**
 * Stores a response inside a transaction that holds lockIdempotencyKey and saw readIdempotent return
 * null: any existing row for the key is expired, so it is overwritten.
 */
export async function writeIdempotent(
  tx: Prisma.TransactionClient,
  key: string,
  endpoint: string,
  fingerprint: string,
  body: unknown,
  ttlHours: number,
): Promise<void> {
  const data = {
    endpoint,
    requestHash: fingerprint,
    responseBody: body as Prisma.InputJsonValue,
    expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
  };
  await tx.idempotencyRecord.upsert({ where: { key }, create: { key, ...data }, update: data });
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async get<T>(key: string, endpoint: string, fingerprint: string): Promise<T | null> {
    return readIdempotent<T>(this.prisma, key, endpoint, fingerprint);
  }

  fingerprint(value: unknown): string {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}
