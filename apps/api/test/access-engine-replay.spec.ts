import { CredentialType, Prisma } from '@prisma/client';
import { AccessEngineService, VerifyContext } from '../src/access/access-engine.service';
import { CredentialsService } from '../src/visitors/credentials.service';
import { PrismaService } from '../src/common/prisma.service';
import { RateLimitService } from '../src/common/rate-limit.service';
import { MqttService } from '../src/devices/mqtt.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { BiometricsService } from '../src/devices/biometrics.service';

describe('AccessEngineService replay protection', () => {
  const SOCIETY = '11111111-1111-4111-8111-111111111111';
  const AP = '33333333-3333-4333-8333-333333333333';
  const DEVICE = '55555555-5555-4555-8555-555555555555';
  const credentials = new CredentialsService();
  const QR = 'qr-token-abcdefghijklmnopqrstuvwx';

  const deviceCtx = (requestId: string, overrides: Partial<VerifyContext> = {}): VerifyContext => ({
    societyId: SOCIETY,
    accessPointId: AP,
    credentialType: 'QR',
    credential: QR,
    requestId,
    source: 'DEVICE',
    deviceId: DEVICE,
    deviceUid: 'gate-01',
    ...overrides,
  });

  function buildPrisma() {
    const pass = {
      id: 'pass-1',
      societyId: SOCIETY,
      hostUserId: 'host-1',
      status: 'ACTIVE',
      validFrom: new Date(Date.now() - 3_600_000),
      validUntil: new Date(Date.now() + 3_600_000),
      usedCount: 0,
      maxUses: 5,
      visitor: { name: 'Guest' },
      accessPoints: [{ accessPointId: AP }],
      flat: { flatNumber: '101' },
    };
    const prisma = {
      idempotencyRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      securityAlert: { create: jest.fn().mockResolvedValue({}) },
      accessPoint: { findFirst: jest.fn().mockResolvedValue({ id: AP, name: 'Main Gate' }) },
      device: { findUnique: jest.fn().mockResolvedValue({ id: DEVICE, societyId: SOCIETY, status: 'ACTIVE' }) },
      deviceAccessPoint: { findUnique: jest.fn().mockResolvedValue({ id: 'link-1' }) },
      deviceCredential: { findFirst: jest.fn().mockResolvedValue({ id: 'cred-dev-1' }) },
      visitorPassCredential: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cred-1',
          type: CredentialType.QR,
          credentialHash: credentials.hash(QR),
          pass,
        }),
      },
      visitorPass: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(pass),
      },
      visitorPassUse: {
        create: jest.fn().mockResolvedValue({ id: 'use-1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      gateCommand: {
        create: jest.fn().mockResolvedValue({ id: 'cmd-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      accessEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
      inTransaction: false,
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => Promise<unknown>) => {
      prisma.inTransaction = true;
      try {
        return await cb(prisma);
      } finally {
        prisma.inTransaction = false;
      }
    });
    return prisma;
  }

  function buildEngine(prisma: ReturnType<typeof buildPrisma>) {
    const rateLimit = { hit: jest.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    const mqtt = { publishCommand: jest.fn().mockResolvedValue(undefined) };
    const notifications = { notifyGateArrival: jest.fn().mockResolvedValue(undefined) };
    const biometrics = {
      verifyResidentBiometric: jest.fn().mockResolvedValue({
        decision: 'AUTHORIZED' as const,
        reasonCode: 'VALID_RESIDENT_BIOMETRIC',
        accessEventId: 'evt-bio-1',
      }),
    };
    const engine = new AccessEngineService(
      prisma as unknown as PrismaService,
      credentials,
      rateLimit as unknown as RateLimitService,
      mqtt as unknown as MqttService,
      notifications as unknown as NotificationsService,
      biometrics as unknown as BiometricsService,
    );
    return { engine, rateLimit, mqtt, notifications, biometrics };
  }

  it('writes the replay record inside the redemption transaction', async () => {
    const prisma = buildPrisma();
    const seenInTx: boolean[] = [];
    prisma.idempotencyRecord.create.mockImplementation(async () => {
      seenInTx.push(prisma.inTransaction);
      return {};
    });
    const { engine, mqtt } = buildEngine(prisma);

    const res = await engine.verify(deviceCtx('req-1'));

    expect(res.decision).toBe('AUTHORIZED');
    expect(seenInTx).toEqual([true]);
    expect(prisma.idempotencyRecord.create.mock.calls[0][0].data).toMatchObject({
      key: `access-verify:${DEVICE}:req-1`,
      requestHash: credentials.hash(QR),
      responseBody: { decision: 'AUTHORIZED', commandId: res.commandId },
    });
    expect(mqtt.publishCommand).toHaveBeenCalledTimes(1);
  });

  it('a concurrent duplicate requestId replays the winner instead of redeeming and opening again', async () => {
    const prisma = buildPrisma();
    const winner = {
      requestHash: credentials.hash(QR),
      responseBody: { decision: 'AUTHORIZED', reasonCode: 'VALID_VISITOR_PASS', accessEventId: 'evt-winner', commandId: 'cmd-winner' },
      expiresAt: new Date(Date.now() + 60_000),
    };
    // Not yet visible at the pre-check (winner still in flight), visible after the unique-key clash.
    prisma.idempotencyRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    prisma.idempotencyRecord.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`key`)', {
        code: 'P2002',
        clientVersion: '6.16.0',
        meta: { target: ['key'] },
      }),
    );
    const { engine, mqtt, notifications } = buildEngine(prisma);

    const res = await engine.verify(deviceCtx('req-dup'));

    expect(res).toEqual(winner.responseBody);
    expect(mqtt.publishCommand).not.toHaveBeenCalled();
    expect(notifications.notifyGateArrival).not.toHaveBeenCalled();
  });

  it('rejects a concurrent duplicate that carries a different credential', async () => {
    const prisma = buildPrisma();
    prisma.idempotencyRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      requestHash: credentials.hash('another-credential-value'),
      responseBody: { decision: 'DENIED', reasonCode: 'INVALID_CREDENTIAL', accessEventId: 'evt-x' },
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.idempotencyRecord.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6.16.0' }),
    );
    const { engine, mqtt } = buildEngine(prisma);

    await expect(engine.verify(deviceCtx('req-dup-2'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      status: 409,
    });
    expect(mqtt.publishCommand).not.toHaveBeenCalled();
  });

  it('rewrites the replay record to the denial when the gate command cannot be dispatched', async () => {
    const prisma = buildPrisma();
    prisma.accessEvent.create.mockResolvedValueOnce({ id: 'evt-auth' }).mockResolvedValueOnce({ id: 'evt-denied' });
    const { engine, mqtt } = buildEngine(prisma);
    mqtt.publishCommand.mockRejectedValueOnce(new Error('MQTT_BROKER_UNAVAILABLE'));

    const res = await engine.verify(deviceCtx('req-mqtt-down'));

    expect(res).toEqual({ decision: 'DENIED', reasonCode: 'CONTROLLER_UNAVAILABLE', accessEventId: 'evt-denied' });
    expect(prisma.idempotencyRecord.update).toHaveBeenCalledWith({
      where: { key: `access-verify:${DEVICE}:req-mqtt-down` },
      data: { responseBody: res },
    });
  });

  it('replays a cached biometric decision instead of actuating the gate again', async () => {
    const prisma = buildPrisma();
    const cachedResponse = { decision: 'AUTHORIZED', reasonCode: 'VALID_RESIDENT_BIOMETRIC', accessEventId: 'evt-bio-0' };
    prisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
      requestHash: credentials.hash('face-template-hash-0001'),
      responseBody: cachedResponse,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { engine, biometrics } = buildEngine(prisma);

    const res = await engine.verify(
      deviceCtx('req-bio-retry', { credentialType: 'FACE', credential: 'face-template-hash-0001' }),
    );

    expect(res).toEqual(cachedResponse);
    expect(biometrics.verifyResidentBiometric).not.toHaveBeenCalled();
  });

  it('rate-limits, records and targets the requesting reader for a fresh biometric scan', async () => {
    const prisma = buildPrisma();
    const { engine, biometrics, rateLimit } = buildEngine(prisma);

    const res = await engine.verify(
      deviceCtx('req-bio-1', { credentialType: 'FINGERPRINT', credential: 'finger-template-hash-01' }),
    );

    expect(res).toEqual({ decision: 'AUTHORIZED', reasonCode: 'VALID_RESIDENT_BIOMETRIC', accessEventId: 'evt-bio-1' });
    expect(rateLimit.hit).toHaveBeenCalledWith(`verify:device:${DEVICE}`, 60, 60);
    expect(biometrics.verifyResidentBiometric).toHaveBeenCalledWith(
      SOCIETY,
      { accessPointId: AP, templateHash: 'finger-template-hash-01', type: 'FINGERPRINT' },
      { deviceId: DEVICE, requestId: 'req-bio-1' },
    );
    expect(prisma.idempotencyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: `access-verify:${DEVICE}:req-bio-1`, responseBody: { pending: true } }),
    });
  });

  it('dispatches exactly once for simultaneous identical biometric requests', async () => {
    const prisma = buildPrisma();
    let claimed = false;
    prisma.idempotencyRecord.create.mockImplementation(async () => {
      if (claimed) throw new Prisma.PrismaClientKnownRequestError('Unique key', { code: 'P2002', clientVersion: '6.16.0' });
      claimed = true;
      return {};
    });
    prisma.idempotencyRecord.findUnique.mockImplementation(async () => claimed ? {
      requestHash: credentials.hash('same-face'), responseBody: { pending: true },
      expiresAt: new Date(Date.now() + 60_000),
    } : null);
    const { engine, biometrics } = buildEngine(prisma);
    const ctx = deviceCtx('parallel-bio', { credentialType: 'FACE', credential: 'same-face' });
    const results = await Promise.allSettled([engine.verify(ctx), engine.verify(ctx)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(biometrics.verifyResidentBiometric).toHaveBeenCalledTimes(1);
  });

  it('claims a biometric request before concurrent callers can actuate', async () => {
    const prisma = buildPrisma();
    prisma.idempotencyRecord.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique key', { code: 'P2002', clientVersion: '6.16.0' }),
    );
    prisma.idempotencyRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      requestHash: credentials.hash('face-template'), responseBody: { pending: true },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { engine, biometrics } = buildEngine(prisma);
    await expect(engine.verify(deviceCtx('bio-race', { credentialType: 'FACE', credential: 'face-template' })))
      .rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    expect(biometrics.verifyResidentBiometric).not.toHaveBeenCalled();
  });

  it('does not reach the biometric reader once the device flood limit is exceeded', async () => {
    const prisma = buildPrisma();
    const { engine, biometrics, rateLimit } = buildEngine(prisma);
    rateLimit.hit.mockResolvedValueOnce({ allowed: false, count: 61 });

    const res = await engine.verify(
      deviceCtx('req-bio-flood', { credentialType: 'FACE', credential: 'face-template-hash-0002' }),
    );

    expect(res.decision).toBe('DENIED');
    expect(res.reasonCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(biometrics.verifyResidentBiometric).not.toHaveBeenCalled();
  });

  it('clears an expired replay record so a reused requestId is evaluated afresh', async () => {
    const prisma = buildPrisma();
    prisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
      requestHash: credentials.hash(QR),
      responseBody: { decision: 'DENIED', reasonCode: 'PASS_NOT_YET_VALID', accessEventId: 'evt-old' },
      expiresAt: new Date(Date.now() - 1_000),
    });
    const { engine } = buildEngine(prisma);

    const res = await engine.verify(deviceCtx('req-old'));

    expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalledWith({
      where: { key: `access-verify:${DEVICE}:req-old`, expiresAt: { lte: expect.any(Date) } },
    });
    expect(res.decision).toBe('AUTHORIZED');
  });
});
