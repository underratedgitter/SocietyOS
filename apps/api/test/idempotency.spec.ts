import { Prisma } from '@prisma/client';
import { AppException } from '../src/common/app.exception';
import { VisitorPassesController } from '../src/visitors/visitor-passes.controller';
import { VisitorPassesService } from '../src/visitors/visitor-passes.service';
import { IdempotencyService, writeIdempotent } from '../src/visitors/idempotency.service';
import { CredentialsService } from '../src/visitors/credentials.service';
import { PrismaService } from '../src/common/prisma.service';
import { AuthzService } from '../src/common/authz.service';
import { AuditService } from '../src/common/audit.service';
import { CreateVisitorPassDto } from '../src/visitors/visitor-passes.dto';
import { JwtUser } from '../src/auth/jwt-auth.guard';

function serviceWith(record: Record<string, jest.Mock>): {
  service: IdempotencyService;
  record: Record<string, jest.Mock>;
} {
  const fullRecord = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    ...record,
  };
  const prisma = { idempotencyRecord: fullRecord };
  return { service: new IdempotencyService(prisma as never), record: fullRecord };
}

describe('IdempotencyService', () => {
  it('produces a stable fingerprint regardless of object key order', () => {
    const { service } = serviceWith({ findUnique: jest.fn(), create: jest.fn() });
    const one = service.fingerprint({ flatId: 'flat', visitor: { name: 'A', phone: null } });
    const two = service.fingerprint({ visitor: { phone: null, name: 'A' }, flatId: 'flat' });
    const changed = service.fingerprint({ flatId: 'other', visitor: { name: 'A', phone: null } });

    expect(one).toBe(two);
    expect(one).not.toBe(changed);
    expect(one).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns a matching cached response', async () => {
    const fingerprint = 'abc';
    const { service } = serviceWith({
      findUnique: jest.fn().mockResolvedValue({
        endpoint: 'visitor-passes.create',
        requestHash: fingerprint,
        responseBody: { pass: { id: 'pass-1' } },
        expiresAt: new Date(Date.now() + 60_000),
      }),
      create: jest.fn(),
    });

    await expect(
      service.get('key', 'visitor-passes.create', fingerprint),
    ).resolves.toEqual({ pass: { id: 'pass-1' } });
  });

  it('treats an expired record as absent', async () => {
    const { service } = serviceWith({
      findUnique: jest.fn().mockResolvedValue({
        endpoint: 'visitor-passes.create',
        requestHash: 'abc',
        responseBody: {},
        expiresAt: new Date(Date.now() - 1),
      }),
      create: jest.fn(),
    });

    await expect(service.get('key', 'visitor-passes.create', 'abc')).resolves.toBeNull();
  });

  it('rejects reuse for another endpoint or a different payload', async () => {
    const base = {
      endpoint: 'visitor-passes.create',
      requestHash: 'abc',
      responseBody: {},
      expiresAt: new Date(Date.now() + 60_000),
    };
    const first = serviceWith({ findUnique: jest.fn().mockResolvedValue(base), create: jest.fn() });
    await expect(first.service.get('key', 'access.verify', 'abc')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    const second = serviceWith({ findUnique: jest.fn().mockResolvedValue(base), create: jest.fn() });
    await expect(second.service.get('key', 'visitor-passes.create', 'different')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });
    await expect(
      second.service.get('key', 'visitor-passes.create', 'different'),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('writeIdempotent upserts so an expired row for the key cannot abort the transaction', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    await writeIdempotent(
      { idempotencyRecord: { upsert } } as unknown as Prisma.TransactionClient,
      'key',
      'visitor-passes.create',
      'abc',
      { ok: true },
      24,
    );
    const args = upsert.mock.calls[0][0];
    expect(args.where).toEqual({ key: 'key' });
    expect(args.create).toMatchObject({ key: 'key', endpoint: 'visitor-passes.create', requestHash: 'abc', responseBody: { ok: true } });
    expect(args.update).toMatchObject({ endpoint: 'visitor-passes.create', requestHash: 'abc', responseBody: { ok: true } });
    const ttlMs = (args.create.expiresAt as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23.9 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3600 * 1000);
  });
});

describe('VisitorPassesController Idempotency Credential Protection', () => {
  it('delegates a fresh key to the transactional create with a 24h TTL and returns credentials once', async () => {
    const mockPasses = {
      create: jest.fn().mockResolvedValue({
        pass: { id: 'pass-999', status: 'ACTIVE' },
        credentials: { pin: '654321', qrToken: 'qr-secret-123' },
      }),
    };
    const mockIdempotency = {
      fingerprint: jest.fn().mockReturnValue('mock-fingerprint'),
      get: jest.fn().mockResolvedValue(null),
    };
    const controller = new VisitorPassesController(
      mockPasses as unknown as VisitorPassesService,
      mockIdempotency as unknown as IdempotencyService,
    );
    const user = { sub: 'user-1' } as unknown as JwtUser;
    const dto = { flatId: 'flat-1' } as unknown as CreateVisitorPassDto;

    const result = (await controller.create(user, dto, 'idem-key-12345')) as {
      credentials?: { pin?: string; qrToken?: string };
    };

    expect(result.credentials).toEqual({ pin: '654321', qrToken: 'qr-secret-123' });
    expect(mockPasses.create).toHaveBeenCalledWith(user, dto, {
      key: 'visitor-passes:user-1:idem-key-12345',
      fingerprint: 'mock-fingerprint',
      ttlHours: 24,
    });
  });

  it('on replay returns pass without credentials and credentialsAlreadyIssued: true', async () => {
    const mockPasses = { create: jest.fn() };
    const mockIdempotency = {
      fingerprint: jest.fn().mockReturnValue('mock-fingerprint'),
      get: jest.fn().mockResolvedValue({
        pass: { id: 'pass-999', status: 'ACTIVE' },
        credentialsAlreadyIssued: true,
      }),
      save: jest.fn(),
    };
    const controller = new VisitorPassesController(
      mockPasses as unknown as VisitorPassesService,
      mockIdempotency as unknown as IdempotencyService,
    );
    const user = { sub: 'user-1' } as unknown as JwtUser;
    const dto = { flatId: 'flat-1' } as unknown as CreateVisitorPassDto;

    const replay = (await controller.create(user, dto, 'idem-key-12345')) as {
      pass: { id: string };
      credentials?: unknown;
      credentialsAlreadyIssued?: boolean;
    };
    expect(replay.pass.id).toBe('pass-999');
    expect(replay.credentials).toBeUndefined();
    expect(replay.credentialsAlreadyIssued).toBe(true);
    expect(mockPasses.create).not.toHaveBeenCalled();
  });
});

describe('VisitorPassesService idempotent create', () => {
  const SOCIETY = '11111111-1111-4111-8111-111111111111';
  const FLAT = '22222222-2222-4222-8222-222222222222';
  const AP = '33333333-3333-4333-8333-333333333333';
  const PASS = '55555555-5555-4555-8555-555555555555';
  const caller: JwtUser = {
    sub: '44444444-4444-4444-8444-444444444444',
    email: 'resident@example.com',
    name: 'Resident',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };
  const idem = { key: 'visitor-passes:u:idem-key-12345', fingerprint: 'fp-1', ttlHours: 24 };
  const dto = (): CreateVisitorPassDto => ({
    flatId: FLAT,
    visitor: { name: 'Guest' },
    category: 'FRIEND' as CreateVisitorPassDto['category'],
    validFrom: new Date(Date.now() + 60_000).toISOString(),
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    accessPointIds: [AP],
  });
  const passRow = {
    id: PASS,
    societyId: SOCIETY,
    flatId: FLAT,
    hostUserId: caller.sub,
    status: 'ACTIVE',
    category: 'FRIEND',
    validFrom: new Date(Date.now() + 60_000),
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

  function build(existing: unknown) {
    const calls: string[] = [];
    let inTx = false;
    const tx = {
      $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(`lock:${sql.join('?').includes("'idempotency'") ? 'key' : 'flat'}:${String(values[0])}`);
        return 1;
      }),
      idempotencyRecord: {
        findUnique: jest.fn(async () => {
          calls.push(`read:${inTx}`);
          return existing;
        }),
        upsert: jest.fn(async () => {
          calls.push(`write:${inTx}`);
          return {};
        }),
      },
      visitorPass: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(async () => {
          calls.push(`create:${inTx}`);
          return { id: PASS };
        }),
        findUnique: jest.fn(async () => {
          calls.push(`view:${inTx}`);
          return passRow;
        }),
      },
      visitor: { findFirst: jest.fn().mockResolvedValue({ id: 'v-1' }), create: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      society: { findUnique: jest.fn().mockResolvedValue({ settings: {} }) },
      accessPoint: { findMany: jest.fn().mockResolvedValue([{ id: AP }]) },
      visitorPass: { findUnique: jest.fn(async () => { calls.push('view:outside'); return passRow; }) },
      $transaction: jest.fn(async (cb: (client: unknown) => Promise<unknown>) => {
        inTx = true;
        try {
          return await cb(tx);
        } finally {
          inTx = false;
        }
      }),
    };
    const authz = { flat: jest.fn().mockResolvedValue({ role: 'RESIDENT', societyId: SOCIETY, flat: { flatNumber: '101' } }) };
    const service = new VisitorPassesService(
      prisma as unknown as PrismaService,
      authz as unknown as AuthzService,
      new CredentialsService(),
      {} as AuditService,
    );
    return { service, tx, calls };
  }

  it('locks the key, creates the pass and stores the sanitized response in one transaction', async () => {
    const { service, tx, calls } = build(null);

    const result = (await service.create(caller, dto(), idem)) as { pass: { id: string }; credentials: { pin: string; qrToken: string } };

    expect(result.pass.id).toBe(PASS);
    expect(result.credentials.pin).toMatch(/^\d+$/);
    expect(calls).toEqual([
      `lock:key:${idem.key}`,
      'read:true',
      `lock:flat:${FLAT}`,
      'create:true',
      'view:true',
      'write:true',
    ]);
    const stored = (tx.idempotencyRecord.upsert.mock.calls[0] as unknown as [{ create: { responseBody: unknown; requestHash: string } }])[0].create;
    expect(stored.requestHash).toBe('fp-1');
    expect(stored.responseBody).toMatchObject({ pass: { id: PASS }, credentialsAlreadyIssued: true });
    const serialized = JSON.stringify(stored.responseBody);
    expect(serialized).not.toContain(result.credentials.pin);
    expect(serialized).not.toContain(result.credentials.qrToken);
  });

  it('replays a response committed by a concurrent request instead of creating a duplicate pass', async () => {
    const cached = { pass: { id: PASS }, credentialsAlreadyIssued: true };
    const { service, tx } = build({
      endpoint: 'visitor-passes.create',
      requestHash: 'fp-1',
      responseBody: cached,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.create(caller, dto(), idem)).resolves.toEqual(cached);
    expect(tx.visitorPass.create).not.toHaveBeenCalled();
    expect(tx.idempotencyRecord.upsert).not.toHaveBeenCalled();
  });

  it('rejects a different payload under the lock', async () => {
    const { service, tx } = build({
      endpoint: 'visitor-passes.create',
      requestHash: 'other-fp',
      responseBody: {},
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.create(caller, dto(), idem)).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(tx.visitorPass.create).not.toHaveBeenCalled();
  });
});
