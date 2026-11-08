import { Logger } from '@nestjs/common';
import { Response } from 'express';
import { AddressInfo, createServer, Server } from 'net';
import { RateLimitService } from '../src/common/rate-limit.service';
import { PrismaService } from '../src/common/prisma.service';
import { MqttService } from '../src/devices/mqtt.service';
import { HealthController } from '../src/health.controller';
import { resetEnvCacheForTests } from '../src/config';

const original = {
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED,
  redisUrl: process.env.REDIS_URL,
};

describe('RateLimitService memory fallback', () => {
  let service: RateLimitService;

  beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.REDIS_URL = '';
    resetEnvCacheForTests();
    service = new RateLimitService();
    service.resetLocal();
  });

  afterEach(() => {
    service.onModuleDestroy();
    restore('RATE_LIMIT_ENABLED', original.rateLimitEnabled);
    restore('REDIS_URL', original.redisUrl);
    resetEnvCacheForTests();
  });

  it('allows requests up to the limit and denies the next one', async () => {
    await expect(service.hit('unit:key', 3, 60)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(service.hit('unit:key', 3, 60)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(service.hit('unit:key', 3, 60)).resolves.toMatchObject({ allowed: true, count: 3 });
    await expect(service.hit('unit:key', 3, 60)).resolves.toMatchObject({ allowed: false, count: 4 });
  });

  it('counts keys independently and can reset the local window', async () => {
    await service.hit('unit:one', 1, 60);
    await expect(service.hit('unit:two', 1, 60)).resolves.toMatchObject({
      allowed: true,
      count: 1,
    });
    await expect(service.hit('unit:one', 1, 60)).resolves.toMatchObject({ allowed: false });

    service.resetLocal();
    await expect(service.hit('unit:one', 1, 60)).resolves.toMatchObject({
      allowed: true,
      count: 1,
    });
  });

  it('resets a specific rate limit key while leaving others intact', async () => {
    await service.hit('unit:reset:a', 1, 60);
    await service.hit('unit:reset:b', 1, 60);
    await expect(service.hit('unit:reset:a', 1, 60)).resolves.toMatchObject({ allowed: false });
    await expect(service.hit('unit:reset:b', 1, 60)).resolves.toMatchObject({ allowed: false });

    await service.reset('unit:reset:a');
    await expect(service.hit('unit:reset:a', 1, 60)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(service.hit('unit:reset:b', 1, 60)).resolves.toMatchObject({ allowed: false });
  });

  it('decrements a rate limit counter without falling below zero', async () => {
    await service.hit('unit:decr', 2, 60);
    await service.hit('unit:decr', 2, 60);
    await expect(service.hit('unit:decr', 2, 60)).resolves.toMatchObject({ allowed: false, count: 3 });

    await service.decrement('unit:decr');
    await service.decrement('unit:decr');
    await expect(service.hit('unit:decr', 2, 60)).resolves.toMatchObject({ allowed: true, count: 2 });

    await service.decrement('unit:nonexistent');
  });

  it('honours the global disable switch', async () => {
    service.onModuleDestroy();
    process.env.RATE_LIMIT_ENABLED = 'false';
    resetEnvCacheForTests();
    service = new RateLimitService();

    await expect(service.hit('unit:disabled', 1, 60)).resolves.toEqual({
      allowed: true,
      count: 0,
      limit: 1,
    });
  });
});

describe('RateLimitService without a usable Redis', () => {
  // Startup may legitimately wait out the service's 5s Redis guard, Jest's default budget too.
  jest.setTimeout(15_000);

  const keys = [
    'NODE_ENV',
    'WEB_URL',
    'JWT_ACCESS_SECRET',
    'CREDENTIAL_HMAC_KEY',
    'REDIS_URL',
    'RATE_LIMIT_ENABLED',
  ] as const;
  const saved = new Map<string, string | undefined>();
  let service: RateLimitService | undefined;
  let noAuthServer: Server | undefined;

  beforeEach(() => {
    for (const key of keys) saved.set(key, process.env[key]);
    process.env.RATE_LIMIT_ENABLED = 'true';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    service?.onModuleDestroy();
    service = undefined;
    if (noAuthServer) await new Promise<void>((resolve) => noAuthServer!.close(() => resolve()));
    noAuthServer = undefined;
    jest.restoreAllMocks();
    for (const [key, value] of saved) restore(key, value);
    resetEnvCacheForTests();
  });

  function useProduction(redisUrl: string): void {
    process.env.NODE_ENV = 'production';
    process.env.WEB_URL = 'https://society.example.com';
    process.env.JWT_ACCESS_SECRET = 'prod-access-secret-0123456789abcdef0123456789';
    process.env.CREDENTIAL_HMAC_KEY = 'prod-credential-key-0123456789abcdef0123456789';
    process.env.REDIS_URL = redisUrl;
    resetEnvCacheForTests();
  }

  /** A Redis-protocol server that, like `requirepass`, rejects unauthenticated commands. */
  async function startNoAuthRedis(): Promise<string> {
    const server = createServer((socket) => {
      socket.on('data', () => socket.write('-NOAUTH Authentication required.\r\n'));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    noAuthServer = server;
    const { port } = server.address() as AddressInfo;
    return `redis://127.0.0.1:${port}`;
  }

  async function unusedPortUrl(): Promise<string> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return `redis://127.0.0.1:${port}`;
  }

  it('refuses to start in production when Redis rejects authentication', async () => {
    useProduction(await startNoAuthRedis());
    service = new RateLimitService();

    await expect(service.onModuleInit()).rejects.toThrow(
      'Redis is required for rate limiting in production',
    );
  });

  it('refuses to start in production when Redis is unreachable', async () => {
    useProduction(await unusedPortUrl());
    service = new RateLimitService();

    await expect(service.onModuleInit()).rejects.toThrow(
      'Redis is required for rate limiting in production',
    );
  });

  it('fails closed in production for brute-force-sensitive (auth) limits', async () => {
    useProduction(await startNoAuthRedis());
    service = new RateLimitService();
    await service.onModuleInit().catch(() => undefined);

    await expect(service.hit('auth:login:ip:203.0.113.9', 20, 900, { failClosed: true })).resolves.toEqual({
      allowed: false,
      count: 0,
      limit: 20,
    });
  });

  it('keeps gate verification working in production during a Redis outage', async () => {
    useProduction(await startNoAuthRedis());
    service = new RateLimitService();
    await service.onModuleInit().catch(() => undefined);

    await expect(service.hit('verify:device:gate-1', 60, 60)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('keeps the in-memory fallback outside production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = await startNoAuthRedis();
    resetEnvCacheForTests();
    service = new RateLimitService();

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.hit('unit:dev', 1, 60)).resolves.toMatchObject({ allowed: true, count: 1 });
  });
});

describe('HealthController readiness with rate limiting', () => {
  function controller(rateLimit: { redisReady: boolean }): HealthController {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      notification: { count: jest.fn().mockResolvedValue(0) },
    };
    return new HealthController(
      prisma as unknown as PrismaService,
      rateLimit as unknown as RateLimitService,
      { connected: true } as unknown as MqttService,
    );
  }

  function response(): { status: jest.Mock } {
    return { status: jest.fn() };
  }

  it('stays ready with Redis degraded so an outage cannot pull every replica (and the gates)', async () => {
    const res = response();
    const body = await controller({ redisReady: false }).readyz(
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.status).toBe('ready');
    expect(body.components.redis).toBe('degraded');
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
