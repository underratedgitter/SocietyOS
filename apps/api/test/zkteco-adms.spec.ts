import { ZktecoAdmsController } from '../src/devices/vendor/zkteco/zkteco-adms.controller';
import {
  buildHandshake,
  deviceLocalTimeToUtc,
  formatCommand,
  parseAttlog,
  parseDeviceCommandResults,
  verifyModeToMethod,
} from '../src/devices/vendor/zkteco/zkteco-protocol';

describe('ZKTeco ADMS parser', () => {
  it('parses multiple ATTLOG lines and skips bad ones', () => {
    const body = [
      '1001\t2025-03-10 09:15:00\t0\t15\t0\t0\t0',
      'garbage line without tabs',
      'bad pin!\t2025-03-10 09:16:00\t0\t1\t0',
      '1002\tnot-a-time\t0\t1\t0',
      '1003\t2025-02-30 10:00:00\t0\t1\t0',
      '',
      '1004\t2025-03-10 09:20:00\t0\t1\t0\r',
    ].join('\r\n');
    const result = parseAttlog(body, 'Asia/Kolkata');
    expect(result.received).toBe(6);
    expect(result.skipped).toBe(4);
    expect(result.events.map((e) => e.deviceUserId)).toEqual(['1001', '1004']);
    expect(result.events[0]).toEqual({
      deviceUserId: '1001',
      method: 'FACE',
      occurredAt: new Date('2025-03-10T03:45:00.000Z'),
      matched: true,
      vendorEventId: '1001|2025-03-10 09:15:00',
    });
  });

  it('maps verify modes', () => {
    expect(verifyModeToMethod('1')).toBe('FINGERPRINT');
    expect(verifyModeToMethod('15')).toBe('FACE');
    expect(verifyModeToMethod('4')).toBe('CARD');
    expect(verifyModeToMethod('3')).toBe('PIN');
    expect(verifyModeToMethod('25')).toBe('PALM');
    expect(verifyModeToMethod('0')).toBe('UNKNOWN');
    expect(verifyModeToMethod('99')).toBe('UNKNOWN');
    expect(verifyModeToMethod('')).toBe('UNKNOWN');
  });

  it('converts Asia/Kolkata (no DST) to UTC', () => {
    expect(deviceLocalTimeToUtc('2025-07-01 00:30:00', 'Asia/Kolkata')?.toISOString()).toBe('2025-06-30T19:00:00.000Z');
  });

  it('handles DST in America/New_York', () => {
    expect(deviceLocalTimeToUtc('2025-01-15 12:00:00', 'America/New_York')?.toISOString()).toBe('2025-01-15T17:00:00.000Z');
    expect(deviceLocalTimeToUtc('2025-07-15 12:00:00', 'America/New_York')?.toISOString()).toBe('2025-07-15T16:00:00.000Z');
    // Spring forward 2025-03-09: 02:30 does not exist, read with the pre-transition offset (EST).
    expect(deviceLocalTimeToUtc('2025-03-09 02:30:00', 'America/New_York')?.toISOString()).toBe('2025-03-09T07:30:00.000Z');
    expect(deviceLocalTimeToUtc('2025-03-09 03:30:00', 'America/New_York')?.toISOString()).toBe('2025-03-09T07:30:00.000Z');
    // Fall back 2025-11-02: 01:30 occurs twice, the earlier (EDT) instant wins.
    expect(deviceLocalTimeToUtc('2025-11-02 01:30:00', 'America/New_York')?.toISOString()).toBe('2025-11-02T05:30:00.000Z');
    expect(deviceLocalTimeToUtc('2025-11-02 02:30:00', 'America/New_York')?.toISOString()).toBe('2025-11-02T07:30:00.000Z');
  });

  it('rejects malformed local times', () => {
    expect(deviceLocalTimeToUtc('2025-13-01 00:00:00', 'UTC')).toBeNull();
    expect(deviceLocalTimeToUtc('2025-03-10T09:15:00', 'UTC')).toBeNull();
    expect(deviceLocalTimeToUtc('2025-03-10 24:00:00', 'UTC')).toBeNull();
  });

  it('builds the handshake option block', () => {
    const text = buildHandshake('SN123');
    expect(text.split('\n')[0]).toBe('GET OPTION FROM: SN123');
    expect(text).toContain('Realtime=1');
    expect(text).toContain('Encrypt=0');
    expect(text).toContain('ErrorDelay=');
  });
});

describe('ZKTeco ADMS command formatting', () => {
  it('formats UPSERT_USER stripping tabs and newlines from the name', () => {
    expect(
      formatCommand({ id: 'c1', kind: 'UPSERT_USER', payload: { deviceUserId: '1001', name: 'A\tB\nC' } }),
    ).toBe('C:c1:DATA UPDATE USERINFO PIN=1001\tName=A B C');
  });

  it('formats DELETE_USER and OPEN_DOOR', () => {
    expect(formatCommand({ id: 'c2', kind: 'DELETE_USER', payload: { deviceUserId: '1001' } })).toBe(
      'C:c2:DATA DELETE USERINFO PIN=1001',
    );
    expect(formatCommand({ id: 'c3', kind: 'OPEN_DOOR', payload: {} })).toBe('C:c3:CONTROL DEVICE 01010105');
  });

  it('refuses unsafe ids and payloads', () => {
    expect(formatCommand({ id: 'c4', kind: 'DELETE_USER', payload: { deviceUserId: '1\nDATA' } })).toBeNull();
    expect(formatCommand({ id: 'c5', kind: 'UPSERT_USER', payload: null })).toBeNull();
    expect(formatCommand({ id: 'bad\nid', kind: 'OPEN_DOOR', payload: {} })).toBeNull();
  });
});

describe('ZKTeco ADMS devicecmd parsing', () => {
  it('parses several result lines', () => {
    const body = 'ID=a1&Return=0&CMD=DATA\r\nID=b2&Return=-1002&CMD=DATA\nnonsense\nID=c3&Return=x&CMD=DATA';
    expect(parseDeviceCommandResults(body)).toEqual([
      { commandId: 'a1', success: true, returnCode: 0 },
      { commandId: 'b2', success: false, returnCode: -1002 },
    ]);
  });
});

describe('ZktecoAdmsController', () => {
  const DEVICE = {
    id: 'dev-1',
    societyId: 'soc-1',
    protocol: 'ZKTECO_ADMS',
    status: 'ACTIVE',
    pushAllowedIps: [] as string[],
    society: { timezone: 'Asia/Kolkata' },
  };

  let prisma: { device: { findUnique: jest.Mock; update: jest.Mock } };
  let ingest: { ingest: jest.Mock };
  let sync: { pull: jest.Mock; acknowledge: jest.Mock };
  let rateLimit: { hit: jest.Mock };
  let controller: ZktecoAdmsController;

  interface FakeRes {
    statusCode: number;
    payload: string;
    type: jest.Mock;
    status: (code: number) => FakeRes;
    send: (text: string) => FakeRes;
  }

  function fakeRes(): FakeRes {
    const res: FakeRes = {
      statusCode: 0,
      payload: '',
      type: jest.fn(),
      status: (code) => {
        res.statusCode = code;
        return res;
      },
      send: (text) => {
        res.payload = text;
        return res;
      },
    };
    return res;
  }

  const call = async (
    run: (res: never, req: never) => Promise<void>,
    body: string | undefined = undefined,
    ip = '10.0.0.5',
  ): Promise<FakeRes> => {
    const res = fakeRes();
    await run(res as never, { ip, body } as never);
    return res;
  };

  beforeEach(() => {
    prisma = {
      device: { findUnique: jest.fn().mockResolvedValue({ ...DEVICE }), update: jest.fn().mockResolvedValue({}) },
    };
    ingest = { ingest: jest.fn().mockResolvedValue([]) };
    sync = { pull: jest.fn().mockResolvedValue([]), acknowledge: jest.fn().mockResolvedValue(undefined) };
    rateLimit = { hit: jest.fn().mockResolvedValue({ allowed: true, count: 1, limit: 120 }) };
    controller = new ZktecoAdmsController(prisma as never, ingest as never, sync as never, rateLimit as never);
  });

  describe('authentication', () => {
    it('rejects an unknown SN', async () => {
      prisma.device.findUnique.mockResolvedValue(null);
      const res = await call((r, q) => controller.handshake('NOPE', q, r));
      expect(res.statusCode).toBe(401);
      expect(res.payload).toMatch(/^ERROR/);
    });

    it('rejects a missing or malformed SN without a DB lookup', async () => {
      const res = await call((r, q) => controller.handshake('a b;', q, r));
      expect(res.statusCode).toBe(401);
      expect(prisma.device.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a device with another protocol', async () => {
      prisma.device.findUnique.mockResolvedValue({ ...DEVICE, protocol: 'NATIVE' });
      expect((await call((r, q) => controller.getRequest('SN1', q, r))).statusCode).toBe(401);
    });

    it('rejects a disabled device', async () => {
      prisma.device.findUnique.mockResolvedValue({ ...DEVICE, status: 'DISABLED' });
      expect((await call((r, q) => controller.getRequest('SN1', q, r))).statusCode).toBe(401);
    });

    it('rejects an IP outside the allowlist and accepts one inside', async () => {
      prisma.device.findUnique.mockResolvedValue({ ...DEVICE, pushAllowedIps: ['203.0.113.9'] });
      expect((await call((r, q) => controller.getRequest('SN1', q, r), undefined, '198.51.100.1')).statusCode).toBe(401);
      expect((await call((r, q) => controller.getRequest('SN1', q, r), undefined, '::ffff:203.0.113.9')).statusCode).toBe(200);
    });

    it('returns 429 when rate limited', async () => {
      rateLimit.hit.mockResolvedValue({ allowed: false, count: 121, limit: 120 });
      const res = await call((r, q) => controller.getRequest('SN1', q, r));
      expect(res.statusCode).toBe(429);
      expect(rateLimit.hit).toHaveBeenCalledWith('iclock:SN1', 120, 60);
      expect(prisma.device.findUnique).not.toHaveBeenCalled();
    });

    it('looks the device up by serial and returns plain text', async () => {
      const res = await call((r, q) => controller.handshake('SN1', q, r));
      expect(prisma.device.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deviceUid: 'SN1' } }),
      );
      expect(res.type).toHaveBeenCalledWith('text/plain');
      expect(res.payload).toContain('GET OPTION FROM: SN1');
    });
  });

  describe('cdata upload', () => {
    it('ingests ATTLOG with the device shape and replies OK: n', async () => {
      const body = '1001\t2025-03-10 09:15:00\t0\t1\t0\n1002\t2025-03-10 09:16:00\t0\t15\t0\nbad';
      const res = await call((r, q) => controller.upload('SN1', 'ATTLOG', q, r), body);
      expect(res.statusCode).toBe(200);
      expect(res.payload).toBe('OK: 3');
      expect(ingest.ingest).toHaveBeenCalledTimes(1);
      const [device, events] = ingest.ingest.mock.calls[0];
      expect(device).toEqual({ id: 'dev-1', societyId: 'soc-1', protocol: 'ZKTECO_ADMS' });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        deviceUserId: '1001',
        method: 'FINGERPRINT',
        matched: true,
        vendorEventId: '1001|2025-03-10 09:15:00',
      });
      expect(events[0].occurredAt.toISOString()).toBe('2025-03-10T03:45:00.000Z');
    });

    it('acknowledges OPERLOG without ingesting', async () => {
      const res = await call((r, q) => controller.upload('SN1', 'OPERLOG', q, r), 'OPLOG 4\t0\t0');
      expect(res.payload).toBe('OK');
      expect(ingest.ingest).not.toHaveBeenCalled();
    });

    it('returns 500 (so the device retries) when ingest throws, without leaking the body', async () => {
      ingest.ingest.mockRejectedValue(new Error('db down'));
      const res = await call((r, q) => controller.upload('SN1', 'ATTLOG', q, r), '1001\t2025-03-10 09:15:00\t0\t1\t0');
      expect(res.statusCode).toBe(500);
      expect(res.payload).not.toContain('1001');
    });
  });

  describe('getrequest', () => {
    it('returns OK when nothing is queued', async () => {
      expect((await call((r, q) => controller.getRequest('SN1', q, r))).payload).toBe('OK');
    });

    it('formats pulled commands (pull marks them sent) and fails unsupported ones', async () => {
      sync.pull.mockResolvedValue([
        { id: 'c1', kind: 'OPEN_DOOR', payload: {} },
        { id: 'c2', kind: 'DELETE_USER', payload: { deviceUserId: '1001' } },
        { id: 'c3', kind: 'DELETE_USER', payload: { deviceUserId: 'bad id' } },
      ]);
      const res = await call((r, q) => controller.getRequest('SN1', q, r));
      expect(sync.pull).toHaveBeenCalledWith('dev-1');
      expect(res.payload).toBe('C:c1:CONTROL DEVICE 01010105\nC:c2:DATA DELETE USERINFO PIN=1001');
      expect(sync.acknowledge).toHaveBeenCalledWith('dev-1', 'c3', false, expect.any(String));
    });
  });

  describe('devicecmd', () => {
    it('acknowledges each result and tolerates unknown ids', async () => {
      sync.acknowledge.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('missing'));
      const res = await call(
        (r, q) => controller.deviceCommand('SN1', q, r),
        'ID=c1&Return=0&CMD=DATA\nID=c2&Return=-3&CMD=DATA',
      );
      expect(res.payload).toBe('OK');
      expect(sync.acknowledge).toHaveBeenNthCalledWith(1, 'dev-1', 'c1', true, undefined);
      expect(sync.acknowledge).toHaveBeenNthCalledWith(2, 'dev-1', 'c2', false, 'Device returned -3');
    });
  });
});
