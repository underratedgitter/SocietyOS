import { MaintenanceService } from '../src/common/maintenance.service';
import { loadEnv, resetEnvCacheForTests } from '../src/config/env';

describe('MaintenanceService', () => {
  let mockPrisma: any;
  let service: MaintenanceService;

  beforeEach(() => {
    delete process.env.CREDENTIAL_RETENTION_DAYS;
    resetEnvCacheForTests();
    mockPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      gateCommand: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      securityAlert: {
        create: jest.fn().mockResolvedValue({ id: 'alert-1' }),
      },
      visitorPass: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      visitor: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      visitorPassCredential: {
        deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      idempotencyRecord: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      session: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new MaintenanceService(mockPrisma);
  });

  afterEach(() => {
    delete process.env.CREDENTIAL_RETENTION_DAYS;
    resetEnvCacheForTests();
  });

  it('does not anonymize repeat visitors who still hold a pass inside the retention window', async () => {
    await service.sweep();

    const where = mockPrisma.visitor.updateMany.mock.calls[0][0].where;
    const cutoff = where.createdAt.lt;
    expect(where.passes).toEqual({ none: { validUntil: { gte: cutoff } } });
  });

  it('deletes credentials of passes expired or revoked more than 30 days ago by default', async () => {
    const beforeSweep = Date.now();
    await service.sweep();

    expect(mockPrisma.visitorPassCredential.deleteMany).toHaveBeenCalledTimes(1);
    const callArg = mockPrisma.visitorPassCredential.deleteMany.mock.calls[0][0];
    expect(callArg).toBeDefined();
    expect(callArg.where).toBeDefined();
    expect(callArg.where.pass).toBeDefined();

    const orClauses = callArg.where.pass.OR;
    expect(Array.isArray(orClauses)).toBe(true);

    const expiredClause = orClauses.find((c: any) => c.status === 'EXPIRED');
    expect(expiredClause).toBeDefined();
    const cutoff30Days = 30 * 24 * 3600 * 1000;
    const actualCutoff = new Date(expiredClause.validUntil.lt).getTime();
    expect(beforeSweep - actualCutoff).toBeGreaterThanOrEqual(cutoff30Days - 2000);
    expect(beforeSweep - actualCutoff).toBeLessThanOrEqual(cutoff30Days + 2000);

    const revokedClause = orClauses.find((c: any) => c.status === 'REVOKED');
    expect(revokedClause).toBeDefined();
  });

  it('honors configurable CREDENTIAL_RETENTION_DAYS environment variable', async () => {
    process.env.CREDENTIAL_RETENTION_DAYS = '14';
    const beforeSweep = Date.now();
    await service.sweep();

    expect(mockPrisma.visitorPassCredential.deleteMany).toHaveBeenCalledTimes(1);
    const callArg = mockPrisma.visitorPassCredential.deleteMany.mock.calls[0][0];
    const expiredClause = callArg.where.pass.OR.find((c: any) => c.status === 'EXPIRED');
    const cutoff14Days = 14 * 24 * 3600 * 1000;
    const actualCutoff = new Date(expiredClause.validUntil.lt).getTime();
    expect(beforeSweep - actualCutoff).toBeGreaterThanOrEqual(cutoff14Days - 2000);
    expect(beforeSweep - actualCutoff).toBeLessThanOrEqual(cutoff14Days + 2000);
  });

  it('covers EXHAUSTED passes with validUntil older than cutoff during credential purge', async () => {
    const beforeSweep = Date.now();
    await service.sweep();

    expect(mockPrisma.visitorPassCredential.deleteMany).toHaveBeenCalledTimes(1);
    const callArg = mockPrisma.visitorPassCredential.deleteMany.mock.calls[0][0];
    const orClauses = callArg.where.pass.OR;
    const exhaustedClause = orClauses.find((c: any) => c.status === 'EXHAUSTED');
    expect(exhaustedClause).toBeDefined();
    expect(exhaustedClause.validUntil).toBeDefined();
    const cutoff30Days = 30 * 24 * 3600 * 1000;
    const actualCutoff = new Date(exhaustedClause.validUntil.lt).getTime();
    expect(beforeSweep - actualCutoff).toBeGreaterThanOrEqual(cutoff30Days - 2000);
    expect(beforeSweep - actualCutoff).toBeLessThanOrEqual(cutoff30Days + 2000);
  });

  it('validates CREDENTIAL_RETENTION_DAYS as positive integer defaulting to 30', () => {
    resetEnvCacheForTests();
    delete process.env.CREDENTIAL_RETENTION_DAYS;
    expect(loadEnv().credentialRetentionDays).toBe(30);

    resetEnvCacheForTests();
    process.env.CREDENTIAL_RETENTION_DAYS = '60';
    expect(loadEnv().credentialRetentionDays).toBe(60);

    resetEnvCacheForTests();
    process.env.CREDENTIAL_RETENTION_DAYS = '  45  ';
    expect(loadEnv().credentialRetentionDays).toBe(45);

    resetEnvCacheForTests();
    process.env.CREDENTIAL_RETENTION_DAYS = '0';
    expect(() => loadEnv()).toThrow('CREDENTIAL_RETENTION_DAYS must be a positive integer');

    resetEnvCacheForTests();
    process.env.CREDENTIAL_RETENTION_DAYS = 'invalid-number';
    expect(() => loadEnv()).toThrow('CREDENTIAL_RETENTION_DAYS must be a positive integer');

    resetEnvCacheForTests();
    process.env.CREDENTIAL_RETENTION_DAYS = '30.5';
    expect(() => loadEnv()).toThrow('CREDENTIAL_RETENTION_DAYS must be a positive integer');

    resetEnvCacheForTests();
    process.env.CREDENTIAL_RETENTION_DAYS = '30days';
    expect(() => loadEnv()).toThrow('CREDENTIAL_RETENTION_DAYS must be a positive integer');

    resetEnvCacheForTests();
    process.env.CREDENTIAL_RETENTION_DAYS = '-5';
    expect(() => loadEnv()).toThrow('CREDENTIAL_RETENTION_DAYS must be a positive integer');
  });

  it('clears pin from every notification older than 24 hours in one set-based update', async () => {
    const beforeSweep = Date.now();

    await service.sweep();

    const pinScrub = mockPrisma.$executeRaw.mock.calls.find(([strings]: [TemplateStringsArray]) =>
      strings.join('?').includes('UPDATE "Notification" SET payload = payload - \'pin\''),
    );
    expect(pinScrub).toBeDefined();
    // No row cap: the old take: 500 batch re-read the same rows and never reached the rest.
    expect(pinScrub[0].join('?')).not.toMatch(/LIMIT/i);
    expect(pinScrub[0].join('?')).toContain("payload ? 'pin'");
    // The visitor's QR pass link carries the QR token and is scrubbed with the PIN.
    expect(pinScrub[0].join('?')).toContain("- 'passUrl'");

    const cutoffTime = (pinScrub[1] as Date).getTime();
    const cutoff24Hours = 24 * 3600 * 1000;
    expect(beforeSweep - cutoffTime).toBeGreaterThanOrEqual(cutoff24Hours - 2000);
    expect(beforeSweep - cutoffTime).toBeLessThanOrEqual(cutoff24Hours + 2000);
  });
});
