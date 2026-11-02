import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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

const REDIS_STARTUP_TIMEOUT_MS = 5000;

/**
 * Fixed-window rate limiter. Redis is used when available so limits hold
 * across API replicas. Outside production a per-process fallback keeps
 * brute-force protection in place during a Redis interruption. In production
 * per-process counters would silently multiply every limit by the replica
 * count, so startup fails without a working Redis connection and requests are
 * denied (fail closed) while Redis is unreachable or rejects authentication.
 */
@Injectable()
export class RateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly enabled = getEnv().rateLimitEnabled;
  private readonly failClosed = getEnv().isProduction && getEnv().rateLimitEnabled;
  private redis: Redis | null = null;
  private startup: Promise<Error | null> = Promise.resolve(null);
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
    this.startup = this.connectAndVerify(this.redis);
  }

  async onModuleInit(): Promise<void> {
    if (!this.failClosed) {
      // The memory fallback covers the gap, so don't delay boot waiting on Redis.
      void this.startup.then((error) => {
        if (error) this.logger.warn(`redis unavailable (${error.message}); in-memory limits active`);
      });
      return;
    }
    const error = await this.startup;
    if (!error) return;
    // Stop ioredis reconnecting so the aborted bootstrap can exit.
    this.redis?.disconnect();
    throw new Error(`Redis is required for rate limiting in production: ${error.message}`);
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  /** Whether limits can be enforced as this environment requires (Redis in production). */
  get healthy(): boolean {
    return !this.failClosed || this.redisReady;
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
    if (this.failClosed) {
      this.logger.error('redis unavailable in production; denying rate-limited request');
      return { allowed: false, count: 0, limit };
    }
    return this.hitMemory(key, limit, windowSec);
  }

  /** Test helper; never exposed over HTTP. */
  resetLocal(): void {
    this.memory.clear();
  }

  async reset(key: string): Promise<void> {
    this.memory.delete(key);
    if (this.redisReady) {
      try {
        await this.redis!.del(`rl:${key}`);
      } catch (err) {
        this.logger.warn(`Failed to reset rate limit for ${key}: ${err}`);
      }
    }
  }

  async decrement(key: string): Promise<void> {
    const entry = this.memory.get(key);
    if (entry && entry.count > 0) {
      entry.count -= 1;
    }
    if (this.redisReady) {
      try {
        await this.redis!.eval(
          `local count = redis.call('GET', KEYS[1])
           if count and tonumber(count) > 0 then
             return redis.call('DECR', KEYS[1])
           end
           return 0`,
          1,
          `rl:${key}`,
        );
      } catch (err) {
        this.logger.warn(`Failed to decrement rate limit for ${key}: ${err}`);
      }
    }
  }

  /** Resolves to the startup failure (never rejects) so callers decide how to react. */
  private async connectAndVerify(redis: Redis): Promise<Error | null> {
    let timer: NodeJS.Timeout | undefined;
    let onError: ((error: Error) => void) | undefined;
    const failure = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no ready connection within ${REDIS_STARTUP_TIMEOUT_MS}ms`)),
        REDIS_STARTUP_TIMEOUT_MS,
      );
      // ioredis reports NOAUTH/WRONGPASS and ECONNREFUSED as 'error' events and
      // then keeps retrying, so connect() alone may never settle.
      onError = (error: Error) => reject(error);
      redis.once('error', onError);
    });
    try {
      await Promise.race([redis.connect().then(() => redis.ping()), failure]);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      if (timer) clearTimeout(timer);
      if (onError) redis.removeListener('error', onError);
    }
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
