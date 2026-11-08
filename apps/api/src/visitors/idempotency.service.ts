import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';

const DEFAULT_TTL_HOURS = 24;

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async get<T>(key: string, endpoint: string, fingerprint: string): Promise<T | null> {
    const record = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
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

  async save(
    key: string,
    endpoint: string,
    fingerprint: string,
    body: unknown,
    ttlHours = DEFAULT_TTL_HOURS,
  ): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          key,
          endpoint,
          requestHash: fingerprint,
          responseBody: body as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.prisma.idempotencyRecord.updateMany({
          where: { key, expiresAt: { lte: new Date() } },
          data: {
            endpoint,
            requestHash: fingerprint,
            responseBody: body as Prisma.InputJsonValue,
            expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
          },
        });
        return;
      }
      throw error;
    }
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
