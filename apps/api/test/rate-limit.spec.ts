import { RateLimitService } from '../src/common/rate-limit.service';
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

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
