import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getEnv } from '../config';

export interface RateHit {
  allowed: boolean;
  count: number;
  limit: number;
}

const LUA_INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

/**
 * Fixed-window rate limiter. Redis is used when available so limits hold
 * across API replicas; a per-process fallback keeps brute-force protection in
 * place during a Redis interruption.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly enabled = getEnv().rateLimitEnabled;
  private redis: Redis | null = null;
  private readonly memory = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    const url = getEnv().redisUrl;
    if (!url || !this.enabled) return;
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    });
    this.redis.on('error', (error) => this.logger.warn(`redis error: ${error.message}`));
    void this.redis.connect().catch(() => this.logger.warn('redis unavailable; in-memory limits active'));
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  get redisReady(): boolean {
    return !!this.redis && this.redis.status === 'ready';
  }

  async hit(key: string, limit: number, windowSec: number): Promise<RateHit> {
    if (!this.enabled) return { allowed: true, count: 0, limit };
    if (this.redisReady) {
      try {
        const count = Number(
          await this.redis!.eval(LUA_INCREMENT, 1, `rl:${key}`, String(windowSec)),
        );
        return { allowed: count <= limit, count, limit };
      } catch {
        this.logger.warn('redis rate-limit failure; falling back to memory');
      }
    }
    return this.hitMemory(key, limit, windowSec);
  }

  /** Test helper; never exposed over HTTP. */
  resetLocal(): void {
    this.memory.clear();
  }

  private hitMemory(key: string, limit: number, windowSec: number): RateHit {
    const now = Date.now();
    const entry = this.memory.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.memory.size > 20_000) this.prune(now);
      this.memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return { allowed: true, count: 1, limit };
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, count: entry.count, limit };
  }

  private prune(now: number): void {
    for (const [key, value] of this.memory) {
      if (value.resetAt <= now) this.memory.delete(key);
    }
  }
}
