import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

export interface RateHit {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Fixed-window rate limiter backed by Redis with an in-memory fallback so the
 * API stays functional (fail-closed per key) if Redis is briefly unavailable.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private redis: Redis | null = null;
  private memory = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      this.redis.on('error', (e) => this.logger.warn(`redis error: ${e.message}`));
      this.redis.connect().catch(() => this.logger.warn('redis unavailable, using in-memory rate limits'));
    }
  }

  get redisReady(): boolean {
    return !!this.redis && this.redis.status === 'ready';
  }

  async hit(key: string, limit: number, windowSec: number): Promise<RateHit> {
    if (this.redisReady) {
      try {
        const rkey = `rl:${key}`;
        const count = await this.redis!.incr(rkey);
        if (count === 1) await this.redis!.expire(rkey, windowSec);
        return { allowed: count <= limit, count, limit };
      } catch {
        this.logger.warn('redis rate-limit failure, falling back to memory');
      }
    }
    return this.hitMemory(key, limit, windowSec);
  }

  private hitMemory(key: string, limit: number, windowSec: number): RateHit {
    const now = Date.now();
    const entry = this.memory.get(key);
    if (!entry || entry.resetAt <= now) {
      this.memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return { allowed: true, count: 1, limit };
    }
    entry.count += 1;
    if (this.memory.size > 10000) this.prune(now);
    return { allowed: entry.count <= limit, count: entry.count, limit };
  }

  private prune(now: number) {
    for (const [k, v] of this.memory) if (v.resetAt <= now) this.memory.delete(k);
  }
}
