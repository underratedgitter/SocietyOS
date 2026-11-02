import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppException } from '../src/common/app.exception';
import { PrismaService } from '../src/common/prisma.service';
import { RateLimitService } from '../src/common/rate-limit.service';
import { sha256 } from '../src/common/crypto.util';
import { BiometricIngestService } from '../src/devices/vendor/biometric-ingest.service';
import { parseDahuaEvents } from '../src/devices/vendor/dahua/dahua-event.parser';
import { parseHikvisionJson, parseHikvisionMultipart } from '../src/devices/vendor/hikvision/hikvision-event.parser';
import { PushDeviceGuard, PushProtocol } from '../src/devices/vendor/push-device.guard';
import { VendorPushController } from '../src/devices/vendor/vendor-push.controller';

function hik(sub: number, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ipAddress: '10.0.0.5',
    dateTime: '2026-11-02T09:30:15+05:30',
    eventType: 'AccessControllerEvent',
    AccessControllerEvent: {
      majorEventType: 5,
      subEventType: sub,
      employeeNoString: '42',
      currentVerifyMode: 'cardOrFaceOrFp',
      serialNo: 1001,
      ...extra,
    },
    ...top,
  };
}

describe('Hikvision parser', () => {
  it('face pass', () => {
    const r = parseHikvisionJson(JSON.stringify(hik(75)));
    expect(r.ignored).toBe(0);
    expect(r.events).toEqual([
      {
        deviceUserId: '42',
        method: 'FACE',
        matched: true,
        occurredAt: new Date('2026-11-02T04:00:15.000Z'),
        vendorEventId: '1001',
      },
    ]);
  });

  it('fingerprint pass', () => {
    const r = parseHikvisionJson(hik(97));
    expect(r.events[0]).toMatchObject({ method: 'FINGERPRINT', matched: true });
  });

  it('face mismatch is a denial', () => {
    const r = parseHikvisionJson(hik(76));
    expect(r.events[0]).toMatchObject({ method: 'FACE', matched: false, deviceUserId: '42' });
  });

  it('fingerprint mismatch is a denial', () => {
    expect(parseHikvisionJson(hik(98)).events[0]).toMatchObject({ method: 'FINGERPRINT', matched: false });
  });

  it('ignores non-verification events, timeouts, heartbeats and offset-less times', () => {
    expect(parseHikvisionJson(hik(22)).events).toEqual([]); // door status
    expect(parseHikvisionJson(hik(79)).events).toEqual([]); // timeout
    expect(parseHikvisionJson({ eventType: 'heartBeat', dateTime: '2026-11-02T09:30:15+05:30' })).toEqual({
      events: [],
      ignored: 1,
    });
    expect(parseHikvisionJson(hik(75, {}, { dateTime: '2026-11-02T09:30:15' }))).toEqual({ events: [], ignored: 1 });
    expect(parseHikvisionJson(hik(76, { employeeNoString: undefined }))).toEqual({ events: [], ignored: 1 });
  });

  it('malformed JSON never throws', () => {
    expect(parseHikvisionJson('{not json')).toEqual({ events: [], ignored: 1 });
    expect(parseHikvisionJson(null)).toEqual({ events: [], ignored: 1 });
    expect(parseHikvisionJson('')).toEqual({ events: [], ignored: 1 });
  });

  it('multipart: reads the event part and discards the picture', () => {
    const picture = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const r = parseHikvisionMultipart([
      { name: 'event_log', mimeType: 'application/json', data: JSON.stringify(hik(75)) },
      { name: 'Picture', mimeType: 'image/jpeg', data: picture },
    ]);
    expect(r.events).toHaveLength(1);
    expect(r.ignored).toBe(0);
  });

  it('multipart: malformed JSON part is counted, not thrown', () => {
    const r = parseHikvisionMultipart([{ name: 'AccessControllerEvent', data: '{oops' }]);
    expect(r).toEqual({ events: [], ignored: 1 });
  });
});

describe('Dahua parser', () => {
  const row = { UserID: '7', Method: 15, Status: 1, UTC: 1793000000, RecNo: 55 };

  it('JSON face success with RecNo as vendorEventId', () => {
    const r = parseDahuaEvents(JSON.stringify({ Code: 'AccessControl', Action: 'Pulse', Data: row }));
    expect(r.events).toEqual([
      { deviceUserId: '7', method: 'FACE', matched: true, occurredAt: new Date(1793000000 * 1000), vendorEventId: '55' },
    ]);
  });

  it('fingerprint failure and card', () => {
    expect(parseDahuaEvents({ ...row, Method: 8, Status: 0 }).events[0]).toMatchObject({
      method: 'FINGERPRINT',
      matched: false,
    });
    expect(parseDahuaEvents({ ...row, Method: 2 }).events[0]).toMatchObject({ method: 'CARD', matched: true });
  });

  it('key=value forms', () => {
    const flat = parseDahuaEvents('UserID=7&Method=15&Status=1&UTC=1793000000&RecNo=55');
    expect(flat.events).toHaveLength(1);
    const attach = parseDahuaEvents(
      `Code=AccessControl;action=Pulse;index=0;data=${JSON.stringify({ ...row, Method: 8 })}`,
    );
    expect(attach.events[0]).toMatchObject({ method: 'FINGERPRINT', vendorEventId: '55' });
  });

  it('Time without UTC uses the supplied local offset', () => {
    const r = parseDahuaEvents('UserID=7&Method=15&Status=1&Time=2026-11-02 09:30:15', { localOffsetMinutes: 330 });
    expect(r.events[0].occurredAt.toISOString()).toBe('2026-11-02T04:00:15.000Z');
  });

  it('ignores other codes, password/button methods and garbage', () => {
    expect(parseDahuaEvents({ Code: 'DoorStatus', Data: row })).toEqual({ events: [], ignored: 1 });
    expect(parseDahuaEvents({ ...row, Method: 1 }).events).toEqual([]);
    expect(parseDahuaEvents('{bad')).toEqual({ events: [], ignored: 1 });
    expect(parseDahuaEvents(undefined).events).toEqual([]);
    expect(parseDahuaEvents('').events).toEqual([]);
  });
});

describe('PushDeviceGuard', () => {
  const TOKEN = 't'.repeat(32);
  type Cred = { revokedAt: Date | null; device: Record<string, unknown> } | null;
  let credential: Cred;
  let hits: { allowed: boolean };
  const prisma = { deviceCredential: { findUnique: jest.fn() } };
  const rateLimit = { hit: jest.fn() };
  let guard: PushDeviceGuard;

  class Probe {
    @PushProtocol('HIKVISION_ISAPI')
    route(): void {}
  }

  function ctx(ip = '10.0.0.5', token = TOKEN, length?: string) {
    const req: Record<string, unknown> = { ip, params: { token }, headers: length ? { 'content-length': length } : {} };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => Probe.prototype.route,
      getClass: () => Probe,
    } as unknown as ExecutionContext;
    return { req, context };
  }

  const device = (over: Record<string, unknown> = {}) => ({
    id: 'dev-1',
    deviceUid: 'uid-1',
    societyId: 'soc-1',
    name: 'Gate',
    status: 'ACTIVE',
    protocol: 'HIKVISION_ISAPI',
    pushAllowedIps: [],
    ...over,
  });

  beforeEach(() => {
    credential = { revokedAt: null, device: device() };
    hits = { allowed: true };
    prisma.deviceCredential.findUnique.mockReset().mockImplementation(async () => credential);
    rateLimit.hit.mockReset().mockImplementation(async () => hits);
    guard = new PushDeviceGuard(
      prisma as unknown as PrismaService,
      rateLimit as unknown as RateLimitService,
      new Reflector(),
    );
  });

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof AppException) return e.code;
      throw e;
    }
    return 'OK';
  };

  it('accepts a valid token and looks it up by hash', async () => {
    const { req, context } = ctx();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.deviceCredential.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256(TOKEN) } }),
    );
    expect(req.device).toMatchObject({ id: 'dev-1', societyId: 'soc-1', protocol: 'HIKVISION_ISAPI' });
  });

  it('rejects unknown, revoked and malformed tokens', async () => {
    credential = null;
    expect(await codeOf(guard.canActivate(ctx().context))).toBe('DEVICE_UNAUTHENTICATED');
    credential = { revokedAt: new Date(), device: device() };
    expect(await codeOf(guard.canActivate(ctx().context))).toBe('DEVICE_UNAUTHENTICATED');
    prisma.deviceCredential.findUnique.mockClear();
    expect(await codeOf(guard.canActivate(ctx('10.0.0.5', 'short').context))).toBe('DEVICE_UNAUTHENTICATED');
    expect(prisma.deviceCredential.findUnique).not.toHaveBeenCalled();
  });

  it('rejects protocol mismatch', async () => {
    credential = { revokedAt: null, device: device({ protocol: 'DAHUA_HTTP' }) };
    expect(await codeOf(guard.canActivate(ctx().context))).toBe('DEVICE_PROTOCOL_MISMATCH');
  });

  it('enforces a non-empty IP allowlist, including IPv4-mapped addresses', async () => {
    credential = { revokedAt: null, device: device({ pushAllowedIps: ['203.0.113.9'] }) };
    expect(await codeOf(guard.canActivate(ctx('198.51.100.1').context))).toBe('DEVICE_IP_NOT_ALLOWED');
    await expect(guard.canActivate(ctx('::ffff:203.0.113.9').context)).resolves.toBe(true);
  });

  it('rejects disabled devices', async () => {
    credential = { revokedAt: null, device: device({ status: 'DISABLED' }) };
    expect(await codeOf(guard.canActivate(ctx().context))).toBe('DEVICE_DISABLED');
  });

  it('rate-limits per device and rejects oversized declared bodies', async () => {
    hits = { allowed: false };
    expect(await codeOf(guard.canActivate(ctx().context))).toBe('RATE_LIMIT_EXCEEDED');
    expect(rateLimit.hit).toHaveBeenCalledWith('device-push:dev-1', expect.any(Number), 60);
    hits = { allowed: true };
    expect(await codeOf(guard.canActivate(ctx('10.0.0.5', TOKEN, String(3 * 1024 * 1024)).context))).toBe(
      'PUSH_BODY_TOO_LARGE',
    );
  });
});

describe('VendorPushController (HTTP)', () => {
  const TOKEN = 'k'.repeat(32);
  let app: INestApplication;
  const ingest = jest.fn();
  const state = { protocol: 'HIKVISION_ISAPI' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VendorPushController],
      providers: [
        PushDeviceGuard,
        { provide: BiometricIngestService, useValue: { ingest } },
        { provide: RateLimitService, useValue: { hit: async () => ({ allowed: true }) } },
        {
          provide: PrismaService,
          useValue: {
            society: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
            deviceCredential: {
              findUnique: async () => ({
                revokedAt: null,
                device: {
                  id: 'dev-1',
                  deviceUid: 'u',
                  societyId: 'soc-1',
                  name: 'g',
                  status: 'ACTIVE',
                  protocol: state.protocol,
                  pushAllowedIps: [],
                },
              }),
            },
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    ingest.mockReset().mockResolvedValue([]);
    state.protocol = 'HIKVISION_ISAPI';
  });

  it('multipart with a picture: 200, ingest gets only the event, image dropped', async () => {
    const res = await request(app.getHttpServer())
      .post(`/device-api/push/${TOKEN}/hikvision`)
      .field('event_log', JSON.stringify(hik(75)), { contentType: 'application/json' })
      .attach('Picture', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]), { filename: 'face.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    const [device, events] = ingest.mock.calls[0];
    expect(device).toEqual({ id: 'dev-1', societyId: 'soc-1', protocol: 'HIKVISION_ISAPI' });
    expect(events).toEqual([
      expect.objectContaining({ deviceUserId: '42', method: 'FACE', matched: true, vendorEventId: '1001' }),
    ]);
  });

  it('JSON body and heartbeat (no ingest call)', async () => {
    const ok = await request(app.getHttpServer()).post(`/device-api/push/${TOKEN}/hikvision`).send(hik(97));
    expect(ok.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    const beat = await request(app.getHttpServer())
      .post(`/device-api/push/${TOKEN}/hikvision`)
      .send({ eventType: 'heartBeat' });
    expect(beat.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('dahua key=value text body returns OK', async () => {
    state.protocol = 'DAHUA_HTTP';
    const res = await request(app.getHttpServer())
      .post(`/device-api/push/${TOKEN}/dahua`)
      .set('Content-Type', 'text/plain')
      .send('UserID=7&Method=15&Status=1&UTC=1793000000&RecNo=55');
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(ingest.mock.calls[0][0]).toEqual({ id: 'dev-1', societyId: 'soc-1', protocol: 'DAHUA_HTTP' });
    expect(ingest.mock.calls[0][1][0]).toMatchObject({ deviceUserId: '7', method: 'FACE', vendorEventId: '55' });
  });

  it('dahua JSON body', async () => {
    state.protocol = 'DAHUA_HTTP';
    const res = await request(app.getHttpServer())
      .post(`/device-api/push/${TOKEN}/dahua`)
      .send({ Code: 'AccessControl', Data: { UserID: '7', Method: 8, Status: 0, UTC: 1793000000, RecNo: 9 } });
    expect(res.status).toBe(200);
    expect(ingest.mock.calls[0][1][0]).toMatchObject({ method: 'FINGERPRINT', matched: false });
  });

  it('protocol mismatch on the route is 403', async () => {
    state.protocol = 'DAHUA_HTTP';
    const res = await request(app.getHttpServer()).post(`/device-api/push/${TOKEN}/hikvision`).send(hik(75));
    expect(res.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });
});
