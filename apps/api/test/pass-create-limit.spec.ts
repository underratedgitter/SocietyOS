import { VisitorPassesService } from '../src/visitors/visitor-passes.service';
import { CredentialsService } from '../src/visitors/credentials.service';
import { PrismaService } from '../src/common/prisma.service';
import { AuthzService } from '../src/common/authz.service';
import { AuditService } from '../src/common/audit.service';
import { JwtUser } from '../src/auth/jwt-auth.guard';
import { NotificationsService } from '../src/notifications/notifications.service';

describe('Visitor pass concurrency guards', () => {
  const SOCIETY = '11111111-1111-4111-8111-111111111111';
  const FLAT = '22222222-2222-4222-8222-222222222222';
  const AP = '33333333-3333-4333-8333-333333333333';
  const caller: JwtUser = {
    sub: '44444444-4444-4444-8444-444444444444',
    email: 'resident@example.com',
    name: 'Resident',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  function build(passesToday: number) {
    const calls: string[] = [];
    let inTx = false;
    const prisma = {
      society: { findUnique: jest.fn().mockResolvedValue({ settings: { maxPassesPerFlatPerDay: 2 } }) },
      accessPoint: { findMany: jest.fn().mockResolvedValue([{ id: AP }]) },
      $executeRaw: jest.fn(async () => {
        calls.push(`lock:${inTx}`);
        return 1;
      }),
      visitorPass: {
        count: jest.fn(async () => {
          calls.push(`count:${inTx}`);
          return passesToday;
        }),
        create: jest.fn(),
      },
      visitor: { findFirst: jest.fn(), create: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        inTx = true;
        try {
          return await cb(prisma);
        } finally {
          inTx = false;
        }
      }),
    };
    const authz = {
      flat: jest.fn().mockResolvedValue({ role: 'RESIDENT', societyId: SOCIETY, flat: { flatNumber: '101' } }),
    };
    const service = new VisitorPassesService(
      prisma as unknown as PrismaService,
      authz as unknown as AuthzService,
      new CredentialsService(),
      {} as AuditService,
    );
    return { service, prisma, calls };
  }

  const dto = () => ({
    flatId: FLAT,
    visitor: { name: 'Guest' },
    category: 'FRIEND' as const,
    validFrom: new Date(Date.now() + 60_000).toISOString(),
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    accessPointIds: [AP],
  });

  it('counts today\'s passes under a per-flat lock inside the insert transaction', async () => {
    const { service, prisma, calls } = build(2);

    await expect(service.create(caller, dto())).rejects.toMatchObject({ code: 'INVITATION_LIMIT', status: 422 });

    // Lock first, then count, both inside the transaction that would insert the pass;
    // a count taken outside it lets parallel requests all pass the check.
    expect(calls).toEqual(['lock:true', 'count:true']);
    const [lockSql, lockFlat] = prisma.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(lockSql.join('?')).toContain('pg_advisory_xact_lock');
    expect(lockFlat).toBe(FLAT);
    expect(prisma.visitorPass.create).not.toHaveBeenCalled();
  });

  describe('revoke', () => {
    const PASS = '55555555-5555-4555-8555-555555555555';
    const passRow = {
      id: PASS,
      societyId: SOCIETY,
      flatId: FLAT,
      hostUserId: caller.sub,
      status: 'ACTIVE',
      category: 'FRIEND',
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 3_600_000),
      maxUses: 1,
      usedCount: 0,
      createdAt: new Date(),
      revokedAt: null,
      visitor: { id: 'v-1', name: 'Guest', phone: null },
      flat: { id: FLAT, flatNumber: '101', building: { name: 'A' } },
      host: { id: caller.sub, name: 'Resident' },
      accessPoints: [],
    };

    function buildRevoke(updatedRows: number) {
      const prisma = {
        visitorPass: {
          findUnique: jest.fn().mockResolvedValue(passRow),
          update: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: updatedRows }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
      };
      const authz = { society: jest.fn().mockResolvedValue({ role: 'SOCIETY_ADMIN', societyId: SOCIETY }) };
      const notifications = { notifyPassRevoked: jest.fn().mockResolvedValue(undefined) };
      const service = new VisitorPassesService(
        prisma as unknown as PrismaService,
        authz as unknown as AuthzService,
        new CredentialsService(),
        {} as AuditService,
        notifications as unknown as NotificationsService,
      );
      return { service, prisma, notifications };
    }

    it('revokes only a not-yet-revoked pass and audits/notifies once', async () => {
      const { service, prisma, notifications } = buildRevoke(1);

      await service.revoke(caller, PASS, 'no longer expected');

      expect(prisma.visitorPass.update).not.toHaveBeenCalled();
      expect(prisma.visitorPass.updateMany).toHaveBeenCalledWith({
        where: { id: PASS, status: { not: 'REVOKED' } },
        data: expect.objectContaining({ status: 'REVOKED', revokedBy: caller.sub }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(notifications.notifyPassRevoked).toHaveBeenCalledTimes(1);
    });

    it('loses a concurrent revoke race without a second audit entry or notification', async () => {
      // Read as ACTIVE, but another revoke committed first: the conditional update matches nothing.
      const { service, prisma, notifications } = buildRevoke(0);

      const view = await service.revoke(caller, PASS, 'duplicate click');

      expect(view.id).toBe(PASS);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(notifications.notifyPassRevoked).not.toHaveBeenCalled();
    });
  });
});
