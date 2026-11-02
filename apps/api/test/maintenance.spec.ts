import { MaintenanceService } from '../src/common/maintenance.service';

describe('MaintenanceService', () => {
  let mockPrisma: any;
  let service: MaintenanceService;

  beforeEach(() => {
    delete process.env.CREDENTIAL_RETENTION_DAYS;
    mockPrisma = {
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
    };
    service = new MaintenanceService(mockPrisma);
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
});
