import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthedRequest } from '../src/auth/jwt-auth.guard';
import { VendorBiometricBatchDto, VendorDeviceApiController } from '../src/devices/vendor/vendor-device.controller';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/common/prisma.service';
import { AuditService } from '../src/common/audit.service';
import { BiometricIngestService } from '../src/devices/vendor/biometric-ingest.service';
import { BiometricIdentityService } from '../src/devices/vendor/biometric-identity.service';
import { DeviceSyncService } from '../src/devices/vendor/device-sync.service';
import { VendorBiometricEvent, dedupeKeyFor } from '../src/devices/vendor/vendor-event';

const SOCIETY = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const AP = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-02T10:00:00.000Z');
const device = { id: DEVICE, societyId: SOCIETY, protocol: 'ZKTECO_ADMS' as const };

function event(overrides: Partial<VendorBiometricEvent> = {}): VendorBiometricEvent {
  return {
    deviceUserId: '1001',
    method: 'FINGERPRINT',
    occurredAt: new Date('2026-11-02T09:59:00.000Z'),
    matched: true,
    ...overrides,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
  });
}

describe('BiometricIngestService', () => {
  function build(opts: {
    identity?: { userId: string; revokedAt: Date | null } | null;
    membership?: { flat: { flatNumber: string } } | null;
    duplicate?: boolean;
    queuedDelete?: boolean;
  }) {
    const accessEventCreate = jest.fn().mockResolvedValue({ id: 'ae-1' });
    const receiptCreate = opts.duplicate
      ? jest.fn().mockRejectedValue(uniqueViolation())
      : jest.fn().mockResolvedValue({ id: 'r-1' });
    const tx = {
      biometricEventReceipt: { create: receiptCreate, update: jest.fn().mockResolvedValue({}) },
      accessEvent: { create: accessEventCreate },
    };
    const prisma = {
      deviceAccessPoint: { findFirst: jest.fn().mockResolvedValue({ accessPointId: AP }) },
      biometricIdentity: { findUnique: jest.fn().mockResolvedValue(opts.identity ?? null) },
      residentFlatMembership: { findFirst: jest.fn().mockResolvedValue(opts.membership ?? null) },
      securityAlert: { create: jest.fn().mockResolvedValue({}) },
      deviceSyncCommand: { findFirst: jest.fn().mockResolvedValue(opts.queuedDelete ? { id: 'c-1' } : null) },
      device: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    const sync = { enqueue: jest.fn().mockResolvedValue(1) };
    const service = new BiometricIngestService(
      prisma as unknown as PrismaService,
      sync as unknown as DeviceSyncService,
    );
    return { service, prisma, sync, accessEventCreate };
  }

  it('authorizes a mapped resident with an active flat and records the punch time', async () => {
    const { service, accessEventCreate, sync } = build({
      identity: { userId: USER, revokedAt: null },
      membership: { flat: { flatNumber: 'A-101' } },
    });

    const [outcome] = await service.ingest(device, [event()], NOW);

    expect(outcome).toMatchObject({ status: 'RECORDED', decision: 'AUTHORIZED', reasonCode: 'VALID_RESIDENT_BIOMETRIC' });
    expect(accessEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId: SOCIETY,
        accessPointId: AP,
        deviceId: DEVICE,
        decision: 'AUTHORIZED',
        requestedAt: new Date('2026-11-02T09:59:00.000Z'),
        meta: expect.objectContaining({ userId: USER, flatNumber: 'A-101', method: 'FINGERPRINT' }),
      }),
    });
    expect(sync.enqueue).not.toHaveBeenCalled();
  });

  it('reports a resent punch as DUPLICATE instead of recording it twice', async () => {
    const { service, accessEventCreate } = build({ identity: { userId: USER, revokedAt: null }, duplicate: true });

    const [outcome] = await service.ingest(device, [event()], NOW);

    expect(outcome).toEqual({ status: 'DUPLICATE', dedupeKey: dedupeKeyFor(event()) });
    expect(accessEventCreate).not.toHaveBeenCalled();
  });

  it('denies a revoked identity, alerts, and queues its removal from the terminal', async () => {
    const { service, prisma, sync } = build({ identity: { userId: USER, revokedAt: new Date('2026-10-01') } });

    const [outcome] = await service.ingest(device, [event()], NOW);

    expect(outcome).toMatchObject({ decision: 'DENIED', reasonCode: 'BIOMETRIC_IDENTITY_REVOKED' });
    expect(prisma.securityAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'VENDOR_DEVICE_STALE_USER' }),
    });
    expect(sync.enqueue).toHaveBeenCalledWith([DEVICE], 'DELETE_USER', { deviceUserId: '1001' });
  });

  it('denies a resident who moved out and does not queue a second delete when one is pending', async () => {
    const { service, sync } = build({ identity: { userId: USER, revokedAt: null }, membership: null, queuedDelete: true });

    const [outcome] = await service.ingest(device, [event()], NOW);

    expect(outcome).toMatchObject({ decision: 'DENIED', reasonCode: 'RESIDENT_MEMBERSHIP_INACTIVE' });
    expect(sync.enqueue).not.toHaveBeenCalled();
  });

  it('alerts on an unmapped terminal user but never deletes it (pre-existing residents)', async () => {
    const { service, prisma, sync } = build({ identity: null });

    const [outcome] = await service.ingest(device, [event()], NOW);

    expect(outcome).toMatchObject({ decision: 'DENIED', reasonCode: 'UNKNOWN_DEVICE_USER' });
    expect(prisma.securityAlert.create).toHaveBeenCalled();
    expect(sync.enqueue).not.toHaveBeenCalled();
  });

  it('logs a scan the terminal itself rejected without alerting', async () => {
    const { service, prisma } = build({ identity: { userId: USER, revokedAt: null } });

    const [outcome] = await service.ingest(device, [event({ matched: false })], NOW);

    expect(outcome).toMatchObject({ decision: 'DENIED', reasonCode: 'BIOMETRIC_NOT_MATCHED_ON_DEVICE' });
    expect(prisma.securityAlert.create).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_DEVICE_USER_ID', event({ deviceUserId: '10 01; DROP' })],
    ['TIMESTAMP_IN_FUTURE', event({ occurredAt: new Date('2026-11-02T10:06:00.000Z') })],
    ['TIMESTAMP_TOO_OLD', event({ occurredAt: new Date('2026-10-25T09:59:00.000Z') })],
    ['INVALID_TIMESTAMP', event({ occurredAt: new Date('not a date') })],
  ])('rejects %s without touching the database', async (reason, bad) => {
    const { service, accessEventCreate } = build({ identity: { userId: USER, revokedAt: null } });

    const [outcome] = await service.ingest(device, [bad], NOW);

    expect(outcome).toMatchObject({ status: 'REJECTED', reason });
    expect(accessEventCreate).not.toHaveBeenCalled();
  });

  it('refuses oversized batches', async () => {
    const { service } = build({});
    await expect(service.ingest(device, Array.from({ length: 501 }, () => event()), NOW)).rejects.toThrow(RangeError);
  });

  it('prefers the vendor event id for dedupe', () => {
    expect(dedupeKeyFor(event({ vendorEventId: 'SN9|42' }))).toBe('id:SN9|42');
    expect(dedupeKeyFor(event())).toBe('u:1001:2026-11-02T09:59:00.000Z');
  });
});

describe('BiometricIdentityService', () => {
  function build(opts: { resident?: boolean; existing?: { id: string; deviceUserId: string; revokedAt: Date | null } | null; maxId?: number | null; createFails?: boolean }) {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ max: opts.maxId ?? null }]),
      biometricIdentity: {
        findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
        create: opts.createFails
          ? jest.fn().mockRejectedValue(uniqueViolation())
          : jest.fn(async ({ data }: { data: { deviceUserId: string } }) => ({ id: 'bi-1', ...data, revokedAt: null })),
        update: jest.fn(async () => ({ ...opts.existing, revokedAt: null })),
      },
    };
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue(opts.resident === false ? null : { id: USER, name: 'A Very Long Resident Name Exceeding' }) },
      device: { findMany: jest.fn().mockResolvedValue([{ id: DEVICE }]) },
      $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const sync = new DeviceSyncService(prisma as unknown as PrismaService);
    const enqueue = jest.spyOn(sync, 'enqueue').mockResolvedValue(1);
    const service = new BiometricIdentityService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      sync,
    );
    return { service, tx, enqueue };
  }

  it('allocates the next numeric id and pushes the user (name truncated) to vendor devices', async () => {
    const { service, enqueue } = build({ maxId: 1041 });

    const identity = await service.assign('admin', SOCIETY, USER);

    expect(identity.deviceUserId).toBe('1042');
    expect(enqueue).toHaveBeenCalledWith([DEVICE], 'UPSERT_USER', {
      deviceUserId: '1042',
      name: 'A Very Long Resident Nam',
    });
  });

  it('keeps an id already enrolled on existing terminals', async () => {
    const { service } = build({});
    expect((await service.assign('admin', SOCIETY, USER, 'EMP-77')).deviceUserId).toBe('EMP-77');
  });

  it('reports a taken id as a conflict', async () => {
    const { service } = build({ createFails: true });
    await expect(service.assign('admin', SOCIETY, USER, '5')).rejects.toMatchObject({ code: 'DEVICE_USER_ID_TAKEN' });
  });

  it('re-activates a revoked identity with the same id instead of issuing a new one', async () => {
    const { service, tx } = build({ existing: { id: 'bi-9', deviceUserId: '7', revokedAt: new Date() } });

    await service.assign('admin', SOCIETY, USER);

    expect(tx.biometricIdentity.update).toHaveBeenCalledWith({ where: { id: 'bi-9' }, data: { revokedAt: null } });
    expect(tx.biometricIdentity.create).not.toHaveBeenCalled();
  });

  it('rejects residents without an active flat in the society', async () => {
    const { service } = build({ resident: false });
    await expect(service.assign('admin', SOCIETY, USER)).rejects.toMatchObject({ code: 'RESIDENT_NOT_FOUND' });
  });

  it('rejects malformed requested ids before any query', async () => {
    const { service, tx } = build({});
    await expect(service.assign('admin', SOCIETY, USER, '1 OR 1=1')).rejects.toMatchObject({ code: 'INVALID_DEVICE_USER_ID' });
    expect(tx.biometricIdentity.findUnique).not.toHaveBeenCalled();
  });
});

describe('DeviceSyncService', () => {
  it('scopes acknowledgements to the reporting device', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const sync = new DeviceSyncService({ deviceSyncCommand: { updateMany } } as unknown as PrismaService);

    await expect(sync.acknowledge(DEVICE, 'cmd-of-other-device', true)).rejects.toMatchObject({ code: 'SYNC_COMMAND_NOT_FOUND' });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cmd-of-other-device', deviceId: DEVICE, status: 'SENT' } }));
  });

  it('marks commands that exhausted their attempts FAILED and only hands out the rest', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValue([{ id: 'c-2', kind: 'DELETE_USER', payload: {} }]);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'c-1' }, { id: 'c-2' }]),
      deviceSyncCommand: { updateMany, findMany },
    };
    const sync = new DeviceSyncService({
      $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as PrismaService);

    const pulled = await sync.pull(DEVICE);

    expect(pulled).toHaveLength(1);
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: { in: ['c-1', 'c-2'] }, attempts: { gte: 5 } },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: { in: ['c-1', 'c-2'] }, attempts: { lt: 5 } },
      data: expect.objectContaining({ status: 'SENT', attempts: { increment: 1 } }),
    }));
  });

  it('returns nothing without writing when the queue is empty', async () => {
    const updateMany = jest.fn();
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]), deviceSyncCommand: { updateMany } };
    const sync = new DeviceSyncService({
      $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as PrismaService);

    expect(await sync.pull(DEVICE)).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('VendorDeviceApiController batch handling', () => {
  it('accepts a batch with one malformed event so ingest rejects it alone (no retry poison pill)', async () => {
    const body = {
      events: [
        { deviceUserId: '1001', method: 'FACE', occurredAt: '2026-11-02T09:59:00+05:30', matched: true },
        { deviceUserId: 'bad id!', method: 'VEIN', occurredAt: 'yesterday', matched: true },
      ],
    };
    const dto = plainToInstance(VendorBiometricBatchDto, body);
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);

    const ingest = { ingest: jest.fn().mockResolvedValue([]) };
    const controller = new VendorDeviceApiController(
      ingest as unknown as BiometricIngestService,
      {} as DeviceSyncService,
    );
    await controller.biometricEvents({ device } as unknown as AuthedRequest, dto);

    const [, events] = ingest.ingest.mock.calls[0] as [unknown, VendorBiometricEvent[]];
    expect(events.map((e) => e.method)).toEqual(['FACE', 'UNKNOWN']);
    expect(Number.isNaN(events[1].occurredAt.getTime())).toBe(true);
  });

  it('still rejects a batch whose shape is wrong', async () => {
    const dto = plainToInstance(VendorBiometricBatchDto, { events: [{ deviceUserId: 5, matched: 'yes' }] });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
