import { Prisma } from '@prisma/client';
import { AppException } from '../src/common/app.exception';
import { IdempotencyService } from '../src/visitors/idempotency.service';
import { VisitorPassesController } from '../src/visitors/visitor-passes.controller';
import { VisitorPassesService } from '../src/visitors/visitor-passes.service';
import { CreateVisitorPassDto } from '../src/visitors/visitor-passes.dto';
import { JwtUser } from '../src/auth/jwt-auth.guard';

function serviceWith(record: Record<string, jest.Mock>): {
  service: IdempotencyService;
  record: Record<string, jest.Mock>;
} {
  const prisma = { idempotencyRecord: record };
  return { service: new IdempotencyService(prisma as never), record };
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

  it('swallows a concurrent duplicate insert', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '6.16.0',
    });
    const { service } = serviceWith({
      findUnique: jest.fn(),
      create: jest.fn().mockRejectedValue(duplicate),
    });

    await expect(
      service.save('key', 'visitor-passes.create', 'abc', { ok: true }),
    ).resolves.toBeUndefined();
  });

  it('does not swallow unrelated database errors', async () => {
    const { service } = serviceWith({
      findUnique: jest.fn(),
      create: jest.fn().mockRejectedValue(new Error('database down')),
    });

    await expect(
      service.save('key', 'visitor-passes.create', 'abc', { ok: true }),
    ).rejects.toThrow('database down');
  });

  it('rejects payload or endpoint mismatch even if record is expired', async () => {
    const expiredRecord = {
      endpoint: 'visitor-passes.create',
      requestHash: 'hash-original',
      responseBody: {},
      expiresAt: new Date(Date.now() - 10_000),
    };
    const { service } = serviceWith({
      findUnique: jest.fn().mockResolvedValue(expiredRecord),
      create: jest.fn(),
    });

    await expect(
      service.get('key', 'visitor-passes.create', 'hash-different'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });

    await expect(
      service.get('key', 'other.endpoint', 'hash-original'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refreshes expired record on P2002 to prevent repeated duplicate creations', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '6.16.0',
    });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = serviceWith({
      findUnique: jest.fn(),
      create: jest.fn().mockRejectedValue(duplicate),
      updateMany,
    });

    await service.save('key', 'visitor-passes.create', 'abc', { ok: true });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ key: 'key' }),
        data: expect.objectContaining({ requestHash: 'abc' }),
      }),
    );
  });

  it('propagates error when updateMany fails during P2002 conflict handling', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '6.16.0',
    });
    const updateMany = jest.fn().mockRejectedValue(new Error('updateMany failed'));
    const { service } = serviceWith({
      findUnique: jest.fn(),
      create: jest.fn().mockRejectedValue(duplicate),
      updateMany,
    });

    await expect(
      service.save('key', 'visitor-passes.create', 'abc', { ok: true }),
    ).rejects.toThrow('updateMany failed');
  });
});

describe('VisitorPassesController Idempotency Credential Protection', () => {
  it('saves responseBody without credentials or pin/qrToken and sets 24h TTL', async () => {
    const mockPasses = {
      create: jest.fn().mockResolvedValue({
        pass: { id: 'pass-999', status: 'ACTIVE' },
        credentials: { pin: '654321', qrToken: 'qr-secret-123' },
      }),
    };
    const mockIdempotency = {
      fingerprint: jest.fn().mockReturnValue('mock-fingerprint'),
      get: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new VisitorPassesController(
      mockPasses as unknown as VisitorPassesService,
      mockIdempotency as unknown as IdempotencyService,
    );
    const user = { sub: 'user-1' } as unknown as JwtUser;
    const dto = {
      flatId: 'flat-1',
      validUntil: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    } as unknown as CreateVisitorPassDto;

    const result = (await controller.create(user, dto, 'idem-key-12345')) as {
      pass: { id: string; status: string };
      credentials?: { pin?: string; qrToken?: string };
    };

    // First call returns credentials to creator
    expect(result.credentials).toEqual({ pin: '654321', qrToken: 'qr-secret-123' });

    // But idempotency.save must NOT contain pin or qrToken and must have 24h TTL
    expect(mockIdempotency.save).toHaveBeenCalledTimes(1);
    const [savedKey, savedEndpoint, savedFingerprint, savedBody, savedTtl] = mockIdempotency.save.mock.calls[0];
    expect(savedKey).toBe('visitor-passes:user-1:idem-key-12345');
    expect(savedTtl).toBe(24);
    expect(savedBody.credentials).toBeUndefined();
    expect(JSON.stringify(savedBody)).not.toContain('654321');
    expect(JSON.stringify(savedBody)).not.toContain('qr-secret-123');
    expect(savedBody.credentialsAlreadyIssued).toBe(true);
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

