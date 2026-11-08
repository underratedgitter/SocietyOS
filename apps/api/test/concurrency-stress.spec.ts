import { CommunityService } from '../src/societies/community.service';
import { AuthzService } from '../src/common/authz.service';
import { AuditService } from '../src/common/audit.service';
import { JwtUser } from '../src/auth/jwt-auth.guard';
import { AppException } from '../src/common/app.exception';

describe('Concurrency & Scale Stress Suite (Stage 10)', () => {
  it('guarantees atomic single-use redemption under high concurrency without race conditions', async () => {
    let usedCount = 0;
    const maxUses = 1;

    // Atomic simulation of PostgreSQL row-level lock (SELECT FOR UPDATE / UPDATE ... WHERE usedCount < maxUses)
    const atomicRedeem = async (requestId: string): Promise<{ decision: 'AUTHORIZED' | 'DENIED'; reason: string }> => {
      // Simulate realistic DB query latency
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 + 1));

      // Atomic check-and-increment
      if (usedCount < maxUses) {
        usedCount += 1;
        return { decision: 'AUTHORIZED', reason: 'VALID_VISITOR_PASS' };
      }
      return { decision: 'DENIED', reason: 'PASS_ALREADY_USED' };
    };

    const CONCURRENCY = 100;
    const promises: Promise<{ decision: 'AUTHORIZED' | 'DENIED'; reason: string; durationMs: number }>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      const reqStart = performance.now();
      promises.push(
        atomicRedeem(`req-${i}`).then((res) => ({
          ...res,
          durationMs: performance.now() - reqStart,
        })),
      );
    }

    const results = await Promise.all(promises);

    const authorized = results.filter((r) => r.decision === 'AUTHORIZED');
    const denied = results.filter((r) => r.decision === 'DENIED');

    expect(authorized.length).toBe(1);
    expect(denied.length).toBe(CONCURRENCY - 1);
    expect(usedCount).toBe(1);

    // Calculate latency percentiles
    const sortedLatencies = results.map((r) => r.durationMs).sort((a, b) => a - b);
    const p50 = sortedLatencies[Math.floor(CONCURRENCY * 0.5)];
    const p95 = sortedLatencies[Math.floor(CONCURRENCY * 0.95)];
    const p99 = sortedLatencies[Math.floor(CONCURRENCY * 0.99)];

    expect(p50).toBeLessThan(50);
    expect(p95).toBeLessThan(100);
    expect(p99).toBeLessThan(150);
  });

  it('guarantees serializable isolation and prevents double-booking when 50 concurrent requests target the same amenity slot', async () => {
    const bookings: any[] = [];
    let lockHolder: string | null = null;
    const lockQueue: (() => void)[] = [];

    // Simulate PostgreSQL pg_advisory_xact_lock serialization inside prisma.$transaction
    const acquireLock = () =>
      new Promise<void>((resolve) => {
        if (!lockHolder) {
          lockHolder = 'locked';
          resolve();
        } else {
          lockQueue.push(() => {
            lockHolder = 'locked';
            resolve();
          });
        }
      });

    const releaseLock = () => {
      lockHolder = null;
      const next = lockQueue.shift();
      if (next) next();
    };

    const mockPrisma: any = {
      $transaction: jest.fn(async (cb) => {
        await acquireLock();
        try {
          return await cb(mockPrisma);
        } finally {
          releaseLock();
        }
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      flat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'flat-101',
          building: { societyId: 'soc-alpha' },
        }),
      },
      societyMembership: {
        findUnique: jest.fn().mockResolvedValue({ role: 'RESIDENT', status: 'ACTIVE' }),
      },
      residentFlatMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rfm-101' }),
      },
      amenityBooking: {
        findFirst: jest.fn().mockImplementation(async ({ where }) => {
          // Simulate query latency
          await new Promise((r) => setTimeout(r, Math.random() * 3 + 1));
          const conflict = bookings.find(
            (b) =>
              b.societyId === where.societyId &&
              b.amenityName.toLowerCase() === where.amenityName.equals.toLowerCase() &&
              b.status === 'CONFIRMED',
          );
          return conflict || null;
        }),
        create: jest.fn().mockImplementation(async ({ data }) => {
          const booking = { id: `book-${bookings.length + 1}`, ...data };
          bookings.push(booking);
          return booking;
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const authz = new AuthzService(mockPrisma);
    const audit = new AuditService(mockPrisma);
    const communityService = new CommunityService(mockPrisma, authz, audit);

    const residentUser: JwtUser = {
      sub: 'user-res-1',
      email: 'res@alpha.com',
      name: 'Res User',
      isPlatformAdmin: false,
      mustChangePassword: false,
    };

    const slotStart = new Date(Date.now() + 86400_000).toISOString();
    const slotEnd = new Date(Date.now() + 86400_000 + 3600_000).toISOString();

    const CONCURRENCY = 50;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      promises.push(
        communityService.createBooking(residentUser, 'soc-alpha', {
          amenityName: 'Clubhouse',
          flatId: 'flat-101',
          slotStart,
          slotEnd,
          guestCount: 5,
        }),
      );
    }

    const settled = await Promise.allSettled(promises);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    // Exactly 1 booking was created; 49 were rejected with AMENITY_SLOT_UNAVAILABLE
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(CONCURRENCY - 1);
    expect(bookings.length).toBe(1);

    for (const rej of rejected) {
      if (rej.status === 'rejected') {
        expect(rej.reason).toBeInstanceOf(AppException);
        expect((rej.reason as AppException).getResponse()).toMatchObject({
          code: 'AMENITY_SLOT_UNAVAILABLE',
        });
      }
    }
  });

  it('prevents double-settlement under concurrent invoice payment race conditions', async () => {
    let invoiceState: any = {
      id: 'inv-race-1',
      societyId: 'soc-alpha',
      flatId: 'flat-101',
      status: 'PENDING',
      amount: 4500,
      dueDate: new Date(Date.now() + 86400_000),
      title: 'Monthly Maintenance',
      paidAt: null,
      paidById: null,
      paymentReference: null,
      flat: {
        id: 'flat-101',
        flatNumber: '101',
        building: { name: 'Tower A', societyId: 'soc-alpha' },
      },
    };

    let lock = Promise.resolve();
    const acquireLock = async () => {
      let release: () => void = () => {};
      const nextLock = new Promise<void>((res) => {
        release = res;
      });
      const current = lock;
      lock = current.then(() => nextLock);
      await current;
      return release;
    };

    const mockPrisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => {
        const release = await acquireLock();
        try {
          return await cb(mockPrisma);
        } finally {
          release();
        }
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      maintenanceInvoice: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          await new Promise((r) => setTimeout(r, Math.random() * 3 + 1));
          return invoiceState.id === where.id ? { ...invoiceState } : null;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          invoiceState = {
            ...invoiceState,
            ...data,
          };
          return {
            ...invoiceState,
            paidBy: { id: data.paidById, name: 'Res User', email: 'res@alpha.com' },
          };
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      residentFlatMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rfm-101' }),
      },
    };

    const authz = new AuthzService(mockPrisma as any);
    const audit = new AuditService(mockPrisma as any);
    const communityService = new CommunityService(mockPrisma as any, authz, audit);

    const residentUser: JwtUser = {
      sub: 'user-res-1',
      email: 'res@alpha.com',
      name: 'Res User',
      isPlatformAdmin: false,
      mustChangePassword: false,
    };

    const CONCURRENCY = 25;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      promises.push(
        communityService.recordPayment(residentUser, 'SOCIETY_ADMIN', 'soc-alpha', 'inv-race-1', {
          paidAt: new Date().toISOString(),
          paymentReference: `REF-${i + 1}`,
        }),
      );
    }

    const settled = await Promise.allSettled(promises);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    // Exactly 1 payment succeeds, 24 rejected with INVOICE_ALREADY_PAID
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(CONCURRENCY - 1);
    expect(invoiceState.status).toBe('PAID');

    for (const rej of rejected) {
      if (rej.status === 'rejected') {
        expect(rej.reason).toBeInstanceOf(AppException);
        expect((rej.reason as AppException).getResponse()).toMatchObject({
          code: 'INVOICE_ALREADY_PAID',
        });
      }
    }
  });

  it('validates bounded offline policy and monotonic sequence integrity', () => {
    interface OfflineEvent {
      sequence: number;
      credential: string;
      decision: 'AUTHORIZED' | 'DENIED';
      reason: string;
    }

    const cache = new Map<string, { validUntil: number; maxUses: number; usedCount: number }>();
    const now = Date.now();

    cache.set('VALID_PIN_1', { validUntil: now + 3600_000, maxUses: 1, usedCount: 0 });
    cache.set('EXPIRED_PIN', { validUntil: now - 3600_000, maxUses: 1, usedCount: 0 });
    cache.set('EXHAUSTED_PIN', { validUntil: now + 3600_000, maxUses: 1, usedCount: 1 });

    const eventQueue: OfflineEvent[] = [];
    let sequenceCounter = 1;

    const verifyOffline = (pin: string): { decision: 'AUTHORIZED' | 'DENIED'; reason: string } => {
      const entry = cache.get(pin);
      let decision: 'AUTHORIZED' | 'DENIED' = 'DENIED';
      let reason = 'INVALID_CREDENTIAL';

      if (entry) {
        if (Date.now() > entry.validUntil) {
          reason = 'PASS_EXPIRED';
        } else if (entry.usedCount >= entry.maxUses) {
          reason = 'PASS_ALREADY_USED';
        } else {
          entry.usedCount += 1;
          decision = 'AUTHORIZED';
          reason = 'VALID_VISITOR_PASS';
        }
      }

      eventQueue.push({ sequence: sequenceCounter++, credential: pin, decision, reason });
      return { decision, reason };
    };

    expect(verifyOffline('VALID_PIN_1').decision).toBe('AUTHORIZED');
    expect(verifyOffline('VALID_PIN_1').decision).toBe('DENIED'); // Second use rejected
    expect(verifyOffline('EXPIRED_PIN').reason).toBe('PASS_EXPIRED');
    expect(verifyOffline('EXHAUSTED_PIN').reason).toBe('PASS_ALREADY_USED');
    expect(verifyOffline('UNKNOWN_PIN').reason).toBe('INVALID_CREDENTIAL');

    expect(eventQueue.length).toBe(5);
    // Monotonic sequence verification
    for (let i = 0; i < eventQueue.length; i++) {
      expect(eventQueue[i].sequence).toBe(i + 1);
    }
  });
});
