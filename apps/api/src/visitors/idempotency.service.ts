import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Idempotency for retryable mutations (pass creation, access verify).
 * First response is stored and replayed verbatim for the same key.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const record = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    return record ? (record.responseBody as T) : null;
  }

  async save(key: string, endpoint: string, body: unknown): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: { key, endpoint, responseBody: body as never },
      });
    } catch {
      // Lost a concurrent save — the stored response wins, which is the point.
    }
  }
}
