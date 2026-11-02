import { VisitorPassesService } from '../src/visitors/visitor-passes.service';
import { JwtUser } from '../src/auth/jwt-auth.guard';

describe('VisitorPassesService Filtered Pagination', () => {
  let service: VisitorPassesService;
  let mockPrisma: any;
  let mockAuthz: any;
  let mockCredentials: any;
  let mockNotifications: any;

  const adminCaller: JwtUser = {
    sub: 'admin-user-id',
    email: 'admin@society.org',
    name: 'Admin User',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  beforeEach(() => {
    mockPrisma = {
      residentFlatMembership: { findMany: jest.fn().mockResolvedValue([]) },
      visitorPass: { findMany: jest.fn() },
    };
    mockAuthz = {
      society: jest.fn().mockResolvedValue({ role: 'SOCIETY_ADMIN', societyId: 'soc-123' }),
    };
    mockCredentials = {};
    mockNotifications = null;

    service = new VisitorPassesService(
      mockPrisma as any,
      mockAuthz as any,
      mockCredentials as any,
      mockNotifications as any,
    );
  });

  it('paginates filtered status records across multiple pages without repetition or skipping', async () => {
    // Generate 15 passes in descending order of createdAt:
    // 0: ACTIVE, 1: EXPIRED, 2: ACTIVE, 3: EXPIRED, 4: ACTIVE,
    // 5: EXPIRED, 6: ACTIVE, 7: EXPIRED, 8: ACTIVE, 9: EXPIRED
    const now = Date.now();
    const fakePasses = Array.from({ length: 15 }, (_, i) => ({
      id: `pass-uuid-${i}`,
      societyId: 'soc-123',
      status: i % 2 === 0 ? 'ACTIVE' : 'EXPIRED',
      category: 'FRIEND',
      validFrom: new Date(now - 10000),
      validUntil: i % 2 === 0 ? new Date(now + 100000) : new Date(now - 5000),
      maxUses: 5,
      usedCount: 0,
      createdAt: new Date(now - i * 1000),
      revokedAt: null,
      visitor: { id: `v-${i}`, name: `Visitor ${i}`, phone: null },
      flat: { id: `f-${i}`, flatNumber: `${100 + i}`, building: { name: 'Tower A' } },
      host: { id: `h-${i}`, name: `Host ${i}` },
      accessPoints: [],
    }));

    // Mock prisma.visitorPass.findMany simulating cursor pagination
    mockPrisma.visitorPass.findMany.mockImplementation((args: any) => {
      let slice = [...fakePasses];
      if (args.cursor) {
        const cursorIndex = slice.findIndex((p) => p.id === args.cursor.id);
        if (cursorIndex !== -1 && args.skip === 1) {
          slice = slice.slice(cursorIndex + 1);
        }
      }
      return Promise.resolve(slice.slice(0, args.take));
    });

    // Page 1: limit 2, filter status = 'ACTIVE'
    const page1 = await service.list(adminCaller, {
      societyId: 'soc-123',
      status: 'ACTIVE',
      limit: 2,
    });

    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].id).toBe('pass-uuid-0');
    expect(page1.items[1].id).toBe('pass-uuid-2');
    expect(page1.nextCursor).toBe('pass-uuid-2');

    // Page 2: limit 2, filter status = 'ACTIVE' using cursor from Page 1
    const page2 = await service.list(adminCaller, {
      societyId: 'soc-123',
      status: 'ACTIVE',
      cursor: page1.nextCursor!,
      limit: 2,
    });

    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].id).toBe('pass-uuid-4');
    expect(page2.items[1].id).toBe('pass-uuid-6');
    expect(page2.nextCursor).toBe('pass-uuid-6');

    // Verify absolutely NO duplicate IDs between page 1 and page 2
    const page1Ids = page1.items.map((it) => it.id);
    const page2Ids = page2.items.map((it) => it.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }

    // Page 3: limit 2
    const page3 = await service.list(adminCaller, {
      societyId: 'soc-123',
      status: 'ACTIVE',
      cursor: page2.nextCursor!,
      limit: 2,
    });

    expect(page3.items).toHaveLength(2);
    expect(page3.items[0].id).toBe('pass-uuid-8');
    expect(page3.items[1].id).toBe('pass-uuid-10');
  });

  it('returns nextCursor when scan limit is reached with fewer than limit matches if more DB rows exist', async () => {
    // 600 passes where only the 1st and 599th pass are ACTIVE, others EXPIRED
    const now = Date.now();
    const passes = Array.from({ length: 600 }, (_, i) => ({
      id: `scan-pass-${i}`,
      societyId: 'soc-123',
      status: i === 0 || i === 599 ? 'ACTIVE' : 'EXPIRED',
      category: 'FRIEND',
      validFrom: new Date(now - 10000),
      validUntil: i === 0 || i === 599 ? new Date(now + 100000) : new Date(now - 5000),
      maxUses: 5,
      usedCount: 0,
      createdAt: new Date(now - i * 1000),
      revokedAt: null,
      visitor: { id: `v-${i}`, name: `Visitor ${i}`, phone: null },
      flat: { id: `f-${i}`, flatNumber: `${100 + i}`, building: { name: 'Tower A' } },
      host: { id: `h-${i}`, name: `Host ${i}` },
      accessPoints: [],
    }));

    mockPrisma.visitorPass.findMany.mockImplementation((args: any) => {
      let slice = [...passes];
      if (args.cursor) {
        const cursorIndex = slice.findIndex((p) => p.id === args.cursor.id);
        if (cursorIndex !== -1 && args.skip === 1) {
          slice = slice.slice(cursorIndex + 1);
        }
      }
      return Promise.resolve(slice.slice(0, args.take));
    });

    // Request limit 5, status ACTIVE
    // Within maxScan (500), only 1 pass (index 0) will match.
    // However, DB still has more rows. nextCursor should not be null!
    const page1 = await service.list(adminCaller, {
      societyId: 'soc-123',
      status: 'ACTIVE',
      limit: 5,
    });

    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].id).toBe('scan-pass-0');
    expect(page1.nextCursor).not.toBeNull();

    // Query next page with nextCursor
    const page2 = await service.list(adminCaller, {
      societyId: 'soc-123',
      status: 'ACTIVE',
      cursor: page1.nextCursor!,
      limit: 5,
    });

    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).toBe('scan-pass-599');
  });
});

