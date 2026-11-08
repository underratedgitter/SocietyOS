import { passQrUrl } from '../src/notifications/notifications.service';
import { Logger } from '@nestjs/common';
import { SmsDispatcherService } from '../src/notifications/sms-dispatcher.service';
import { MOCK_STORE_LIMIT, maskToken } from '../src/notifications/redaction';
import { WhatsappDispatcherService } from '../src/notifications/whatsapp-dispatcher.service';
import { PushDispatcherService } from '../src/notifications/push-dispatcher.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushTokenController } from '../src/notifications/push-token.controller';
import { JwtUser } from '../src/auth/jwt-auth.guard';
import * as config from '../src/config';

describe('Notifications Subsystem Suite (SMS, WhatsApp, Push & Outbox Dispatcher)', () => {
  describe('SmsDispatcherService', () => {
    let sms: SmsDispatcherService;

    beforeEach(() => {
      sms = new SmsDispatcherService();
      sms.clearMockSentStore();
    });

    test('normalizes various phone number formats into E.164 (+91 standard)', () => {
      expect(sms.normalizePhoneNumber('9876543210')).toBe('+919876543210');
      expect(sms.normalizePhoneNumber('09876543210')).toBe('+919876543210');
      expect(sms.normalizePhoneNumber('+91 98765-43210')).toBe('+919876543210');
      expect(sms.normalizePhoneNumber('919876543210')).toBe('+919876543210');
      expect(sms.normalizePhoneNumber('+1 (555) 123-4567')).toBe('+15551234567');
    });

    test('formats all standard SocietyOS notification templates', () => {
      const passIssuedMsg = sms.formatMessage('VISITOR_PASS_ISSUED', {
        flatNumber: '402',
        pin: '839201',
        validWindow: 'Today 4PM - 8PM',
        passUrl: 'https://society.dev/p/pass-1',
      });
      expect(passIssuedMsg).toContain('Flat 402');
      expect(passIssuedMsg).toContain('839201');
      expect(passIssuedMsg).toContain('https://society.dev/p/pass-1');

      const arrivalMsg = sms.formatMessage('VISITOR_ARRIVED', {
        visitorName: 'Rajesh Kumar',
        accessPointName: 'Main Gate Barrier',
        flatNumber: '402',
      });
      expect(arrivalMsg).toContain('Rajesh Kumar');
      expect(arrivalMsg).toContain('Main Gate Barrier');
      expect(arrivalMsg).toContain('Flat 402');

      const paymentMsg = sms.formatMessage('PAYMENT_CONFIRMATION', {
        title: 'Q3 Maintenance',
        amount: 4500,
        paymentReference: 'TXN-9988',
      });
      expect(paymentMsg).toContain('INR 4500');
      expect(paymentMsg).toContain('TXN-9988');
    });

    test('dispatches SMS to mock store and logs delivery', async () => {
      const res = await sms.sendSms('9876543210', 'VISITOR_PASS_ISSUED', {
        flatNumber: '101',
        pin: '123456',
      });

      expect(res.success).toBe(true);
      expect(res.provider).toBe('mock');

      const store = sms.getMockSentStore();
      expect(store).toHaveLength(1);
      expect(store[0].to).toBe('+919876543210');
      expect(store[0].message).toContain('123456');
    });

    test('mock delivery never logs the full phone number or the visitor PIN', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        await sms.sendSms('9876543210', 'VISITOR_PASS_ISSUED', { flatNumber: '101', pin: '123456' });
        const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain('***3210');
        expect(logged).not.toContain('9876543210');
        expect(logged).not.toContain('123456');
      } finally {
        logSpy.mockRestore();
      }
    });

    test('mock store is bounded so the production fallback cannot leak memory', async () => {
      for (let i = 0; i < MOCK_STORE_LIMIT + 25; i++) {
        await sms.sendSms('9876543210', 'VISITOR_ARRIVED', { visitorName: `V${i}` });
      }
      const store = sms.getMockSentStore();
      expect(store).toHaveLength(MOCK_STORE_LIMIT);
      expect(store[store.length - 1].message).toContain(`V${MOCK_STORE_LIMIT + 24}`);
    });
  });

  describe('WhatsappDispatcherService', () => {
    let whatsapp: WhatsappDispatcherService;

    beforeEach(() => {
      whatsapp = new WhatsappDispatcherService();
      whatsapp.clearMockSentStore();
    });

    test('formats WhatsApp message with rich markdown layout and emojis', () => {
      const msg = whatsapp.formatMessage('VISITOR_ARRIVED', {
        visitorName: 'Sneha Rao',
        accessPointName: 'South Pedestrian Turnstile',
        flatNumber: '204',
        at: '2026-11-01T12:00:00.000Z',
      });

      expect(msg).toContain('🚪 *Gate Arrival Alert*');
      expect(msg).toContain('*Sneha Rao*');
      expect(msg).toContain('*South Pedestrian Turnstile*');
      expect(msg).toContain('*Flat 204*');
    });

    test('dispatches WhatsApp notification safely into store', async () => {
      const res = await whatsapp.sendWhatsapp('+919888877777', 'VISITOR_PASS_APPROVED', {
        flatNumber: '305',
        pin: '778899',
      });

      expect(res.success).toBe(true);
      expect(res.provider).toBe('mock');

      const store = whatsapp.getMockSentStore();
      expect(store).toHaveLength(1);
      expect(store[0].to).toBe('+919888877777');
      expect(store[0].message).toContain('778899');
    });

    test('mock delivery never logs the full phone number or the visitor PIN', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        await whatsapp.sendWhatsapp('+919888877777', 'VISITOR_PASS_ISSUED', {
          flatNumber: '305',
          pin: '778899',
        });
        const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain('***7777');
        expect(logged).not.toContain('9888877777');
        expect(logged).not.toContain('778899');
      } finally {
        logSpy.mockRestore();
      }
    });

    test('mock store is bounded so the production fallback cannot leak memory', async () => {
      for (let i = 0; i < MOCK_STORE_LIMIT + 25; i++) {
        await whatsapp.sendWhatsapp('+919888877777', 'VISITOR_ARRIVED', { visitorName: `V${i}` });
      }
      const store = whatsapp.getMockSentStore();
      expect(store).toHaveLength(MOCK_STORE_LIMIT);
      expect(store[store.length - 1].message).toContain(`V${MOCK_STORE_LIMIT + 24}`);
    });
  });

  describe('PushDispatcherService', () => {
    let mockPrisma: any;
    let push: PushDispatcherService;

    beforeEach(() => {
      mockPrisma = {
        pushDeviceToken: {
          findMany: jest.fn(),
          deleteMany: jest.fn(),
        },
      };
      push = new PushDispatcherService(mockPrisma);
      push.clearMockSentStore();
    });

    describe('live web push dispatch (production)', () => {
      beforeEach(() => {
        const realEnv = config.getEnv();
        jest.spyOn(config, 'getEnv').mockReturnValue({ ...realEnv, nodeEnv: 'production', isProduction: true });
      });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      test('does not follow redirects and treats a 3xx response as a delivery failure', async () => {
        const fetchSpy = jest
          .spyOn(global, 'fetch')
          .mockResolvedValue(new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } }));

        await expect(
          push.sendWebPush('tok-1', 'https://fcm.googleapis.com/fcm/send/sub1', null, null, 't', 'b'),
        ).rejects.toThrow(/redirect/i);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
      });

      test('re-validates the stored endpoint before fetching and counts it as failed', async () => {
        const fetchSpy = jest.spyOn(global, 'fetch');
        mockPrisma.pushDeviceToken.findMany.mockResolvedValue([
          // Stored before the allowlist existed; must never be fetched.
          { id: 'dev-x', token: 'web-legacy', platform: 'web', endpoint: 'https://metadata.attacker.example/push' },
        ]);

        const res = await push.sendToUser('user-1', 'VISITOR_ARRIVED', { visitorName: 'X' });

        expect(res).toEqual({ sentCount: 0, failedCount: 1 });
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      test('counts non-2xx web push responses as failures', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

        await expect(
          push.sendWebPush('tok-1', 'https://fcm.googleapis.com/fcm/send/sub1', null, null, 't', 'b'),
        ).rejects.toThrow(/HTTP 500/);
      });
    });

    test('validates Expo Push Token formats', () => {
      expect(push.isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
      expect(push.isExpoPushToken('ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
      expect(push.isExpoPushToken('invalid-token')).toBe(false);
      expect(push.isExpoPushToken('')).toBe(false);
    });

    test('sends push notification to all active devices registered for user', async () => {
      mockPrisma.pushDeviceToken.findMany.mockResolvedValue([
        { id: 'dev-1', token: 'ExponentPushToken[token1]', platform: 'expo' },
        { id: 'dev-2', token: 'web-endpoint-token', platform: 'web', endpoint: 'https://fcm.googleapis.com/fcm/send/sub1' },
      ]);

      const res = await push.sendToUser('user-1', 'VISITOR_ARRIVED', {
        visitorName: 'Courier Agent',
        accessPointName: 'Lobby Door',
      });

      expect(res.sentCount).toBe(2);
      expect(res.failedCount).toBe(0);

      const store = push.getMockSentStore();
      expect(store).toHaveLength(2);
      expect(store[0].title).toBe('Visitor Arrived');
      expect(store[0].body).toContain('Courier Agent');
    });

    test('dispatches push notifications to devices with ios and android platforms', async () => {
      mockPrisma.pushDeviceToken.findMany.mockResolvedValue([
        { id: 'dev-ios', token: 'ExponentPushToken[ios-token]', platform: 'ios' },
        { id: 'dev-android', token: 'ExponentPushToken[android-token]', platform: 'android' },
      ]);

      const res = await push.sendToUser('user-2', 'VISITOR_PASS_APPROVED', {
        flatNumber: '502',
      });

      expect(res.sentCount).toBe(2);
      expect(res.failedCount).toBe(0);
      const store = push.getMockSentStore();
      expect(store).toHaveLength(2);
      expect(store[0].body).toContain('Flat 502');
    });
  });

  describe('NotificationsService Outbox & Automation', () => {
    let mockPrisma: any;
    let sms: SmsDispatcherService;
    let whatsapp: WhatsappDispatcherService;
    let push: PushDispatcherService;
    let notifications: NotificationsService;

    beforeEach(() => {
      mockPrisma = {
        notification: {
          create: jest.fn(),
          findMany: jest.fn(),
          updateMany: jest.fn(),
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn(),
        },
        pushDeviceToken: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      sms = new SmsDispatcherService();
      whatsapp = new WhatsappDispatcherService();
      push = new PushDispatcherService(mockPrisma);
      notifications = new NotificationsService(mockPrisma, sms, whatsapp, push);
    });

    test.each(['created', 'approved'] as const)(
      'keeps PIN and QR link out of push payloads for %s passes (visitor SMS/WhatsApp only)',
      async (kind) => {
        const enqueue = jest.spyOn(notifications, 'enqueue').mockResolvedValue(undefined as never);
        const params = {
          societyId: 'soc-1',
          flatId: 'flat-1',
          flatNumber: '101',
          visitorName: 'Guest',
          visitorPhone: '+919876500000',
          hostUserId: 'host-1',
          pin: '123456',
          qrToken: 'qr-token-abcdefghijklmnop',
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 3600_000),
          passId: 'pass-1',
        };
        if (kind === 'created') await notifications.notifyPassCreated(params);
        else await notifications.notifyPassApproved(params);

        const byChannel = (channel: string) =>
          enqueue.mock.calls.map(([input]) => input).filter((input) => input.channel === channel);
        for (const push of byChannel('PUSH')) {
          expect(push.payload).not.toHaveProperty('pin');
          expect(push.payload).not.toHaveProperty('passUrl');
        }
        for (const channel of ['SMS', 'WHATSAPP']) {
          expect(byChannel(channel)[0].payload).toMatchObject({ pin: '123456', passUrl: expect.stringContaining('#qr=') });
        }
        enqueue.mockRestore();
      },
    );

    test('enqueue creates persistent outbox record', async () => {
      await notifications.enqueue({
        societyId: 'soc-1',
        userId: 'user-1',
        channel: 'SMS',
        template: 'VISITOR_PASS_ISSUED',
        payload: { flatNumber: '101' },
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          societyId: 'soc-1',
          userId: 'user-1',
          channel: 'SMS',
          template: 'VISITOR_PASS_ISSUED',
        }),
      });
    });

    test('notifyPassCreated dispatches to visitor (SMS + WhatsApp) and host (Push)', async () => {
      await notifications.notifyPassCreated({
        societyId: 'soc-1',
        flatId: 'flat-1',
        flatNumber: '101',
        visitorName: 'Aarav Sharma',
        visitorPhone: '+919876500000',
        hostUserId: 'user-host',
        pin: '654321',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 3600_000),
        passId: 'pass-101',
      });

      // Should enqueue 3 notifications: SMS to visitor, WhatsApp to visitor, Push to host
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(3);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channel: 'SMS', template: 'VISITOR_PASS_ISSUED' }),
        }),
      );
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channel: 'WHATSAPP', template: 'VISITOR_PASS_ISSUED' }),
        }),
      );
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channel: 'PUSH', template: 'VISITOR_PASS_ISSUED', userId: 'user-host' }),
        }),
      );
    });

    test('notifyGateArrival alerts resident via Push, SMS, and WhatsApp when phone is configured', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ phone: '+919999988888' });

      await notifications.notifyGateArrival({
        societyId: 'soc-1',
        hostUserId: 'user-host',
        visitorName: 'Deepak Verma',
        accessPointName: 'Gate 1',
        flatNumber: '302',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(3);
    });

    test('drain delivers pending notifications and marks SENT', async () => {
      const mockPending = [
        {
          id: 'notif-1',
          channel: 'SMS',
          template: 'VISITOR_PASS_ISSUED',
          payload: { phone: '+919876543210', flatNumber: '101', pin: '998877' },
          attempts: 0,
        },
      ];

      mockPrisma.notification.findMany.mockResolvedValue(mockPending);
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.notification.update.mockResolvedValue({ id: 'notif-1', status: 'SENT' });

      await notifications.drain();

      expect(mockPrisma.notification.updateMany).toHaveBeenCalled();
      expect(mockPrisma.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'notif-1' },
          data: expect.objectContaining({ status: 'SENT' }),
        }),
      );
    });

    test('a sent notification no longer has a pin in its payload', async () => {
      const mockPending = [
        {
          id: 'notif-sent-1',
          channel: 'SMS',
          template: 'VISITOR_PASS_ISSUED',
          payload: { phone: '+919876543210', flatNumber: '101', pin: '998877' },
          attempts: 0,
        },
      ];

      mockPrisma.notification.findMany.mockResolvedValue(mockPending);
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.notification.update.mockResolvedValue({ id: 'notif-sent-1', status: 'SENT' });

      await notifications.drain();

      expect(mockPrisma.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'notif-sent-1' },
          data: expect.objectContaining({
            status: 'SENT',
            payload: { phone: '+919876543210', flatNumber: '101' },
          }),
        }),
      );
    });

    test('a permanently failed notification no longer has a pin in its payload', async () => {
      const mockPending = [
        {
          id: 'notif-failed-1',
          channel: 'PUSH',
          template: 'VISITOR_PASS_APPROVED',
          payload: { token: 'invalid-token', flatNumber: '202', pin: '445566' },
          attempts: 4, // 5th attempt will fail permanently
        },
      ];

      mockPrisma.notification.findMany.mockResolvedValue(mockPending);
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.notification.update.mockResolvedValue({ id: 'notif-failed-1', status: 'FAILED' });

      // Mock push delivery failure
      jest.spyOn(push, 'sendExpoPushBatch').mockResolvedValue({ sent: 0, failed: 1 });

      await notifications.drain();

      expect(mockPrisma.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'notif-failed-1' },
          data: expect.objectContaining({
            status: 'FAILED',
            payload: { token: 'invalid-token', flatNumber: '202' },
          }),
        }),
      );
    });
  });

  describe('PushTokenController', () => {
    let mockPrisma: any;
    let controller: PushTokenController;
    const testUser: JwtUser = {
      sub: 'user-100',
      email: 'res@societyos.dev',
      name: 'Resident',
      isPlatformAdmin: false,
      mustChangePassword: false,
    };

    beforeEach(() => {
      mockPrisma = {
        pushDeviceToken: {
          upsert: jest.fn(),
          deleteMany: jest.fn(),
          findMany: jest.fn(),
        },
      };
      controller = new PushTokenController(mockPrisma);
    });

    test('registers or updates device push token', async () => {
      mockPrisma.pushDeviceToken.upsert.mockResolvedValue({
        id: 'token-rec-1',
        platform: 'expo',
      });

      const res = await controller.registerToken(testUser, {
        token: 'ExponentPushToken[test12345]',
        platform: 'expo',
        deviceName: 'Pixel 8',
      });

      expect(res.ok).toBe(true);
      expect(res.id).toBe('token-rec-1');
      expect(mockPrisma.pushDeviceToken.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token: 'ExponentPushToken[test12345]' },
        }),
      );
    });

    test('unregisters device token on logout', async () => {
      mockPrisma.pushDeviceToken.deleteMany.mockResolvedValue({ count: 1 });

      const res = await controller.unregisterToken(testUser, {
        token: 'ExponentPushToken[test12345]',
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.pushDeviceToken.deleteMany).toHaveBeenCalledWith({
        where: {
          token: 'ExponentPushToken[test12345]',
          userId: 'user-100',
        },
      });
    });

    test('rejects push token registration with invalid or SSRF web push endpoints (Issue 9)', async () => {
      const disallowedEndpoints = [
        'http://fcm.googleapis.com/send', // Not HTTPS
        'http://127.0.0.1:4000/api', // Localhost IPv4
        'https://localhost:4000/api', // Localhost hostname
        'https://169.254.169.254/latest/meta-data', // AWS/cloud metadata service
        'https://10.0.0.5:8443/push', // RFC 1918 private network
        'https://192.168.1.100:443/endpoint', // RFC 1918 private network
        'https://172.16.0.10:443/endpoint', // RFC 1918 private network
        'https://[::ffff:169.254.169.254]/latest/meta-data', // IPv6-mapped cloud metadata
        'https://[::ffff:127.0.0.1]/push', // IPv6-mapped localhost
        'https://[::]/push', // IPv6 unspecified address
        'https://100.64.0.1:8443/push', // CGNAT
        'https://api:4000/internal', // Internal docker container name
        'not-a-url', // Malformed URL
        'https://push.example.com/endpoint', // Public host that is not a browser push service
        'https://internal-alias.attacker.example/push', // DNS name that may resolve to an internal IP
        'https://fcm.googleapis.com.evil.com/fcm/send/x', // Lookalike suffix of an allowlisted host
        'https://evilfcm.googleapis.com/fcm/send/x', // Different subdomain of an allowlisted host
        'https://notify.windows.com/w', // Bare suffix without a regional label
        'https://fcm.googleapis.com:8443/fcm/send/x', // Non-default port
        'https://user:pw@fcm.googleapis.com/fcm/send/x', // Embedded credentials
        'http://updates.push.services.mozilla.com/wpush/v2/x', // Allowlisted host over http
      ];

      for (const endpoint of disallowedEndpoints) {
        await expect(
          controller.registerToken(testUser, {
            token: `token-web-${Math.random()}`,
            platform: 'web',
            endpoint,
          }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            code: expect.stringMatching(/INVALID_PUSH_ENDPOINT|DISALLOWED_PUSH_ENDPOINT/),
          }),
        });
      }
    });

    test('accepts valid public HTTPS web push endpoint', async () => {
      mockPrisma.pushDeviceToken.upsert.mockResolvedValue({
        id: 'token-rec-web',
        platform: 'web',
      });

      const res = await controller.registerToken(testUser, {
        token: 'token-web-valid-999',
        platform: 'web',
        endpoint: 'https://fcm.googleapis.com/fcm/send/token-web-valid-999',
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.pushDeviceToken.upsert).toHaveBeenCalled();
    });

    test('accepts endpoints of every supported browser push service', async () => {
      mockPrisma.pushDeviceToken.upsert.mockResolvedValue({ id: 'token-rec-web', platform: 'web' });
      const allowed = [
        'https://fcm.googleapis.com/fcm/send/abc',
        'https://updates.push.services.mozilla.com/wpush/v2/abc',
        'https://web.push.apple.com/QGx',
        'https://wns2-par02p.notify.windows.com/w/?token=abc',
      ];

      for (const endpoint of allowed) {
        await expect(
          controller.registerToken(testUser, { token: `token-${endpoint.length}`, platform: 'web', endpoint }),
        ).resolves.toMatchObject({ ok: true });
      }
    });
  });
});

describe('maskToken', () => {
  it('keeps only a short suffix of push tokens for logs', () => {
    const token = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
    expect(maskToken(token)).toBe('***rstuv]');
    expect(maskToken(token)).not.toContain('abcdef');
    expect(maskToken('short')).toBe('****');
  });
});

describe('visitor QR pass link', () => {
  it('keeps the QR token in the URL fragment so it never reaches a server log', () => {
    const url = new URL(passQrUrl('pass-1', 'tok/en+=='));
    expect(url.pathname).toBe('/p/pass-1');
    expect(url.search).toBe('');
    expect(decodeURIComponent(url.hash)).toBe('#qr=tok/en+==');
  });

  it('includes the QR link in the approval SMS and WhatsApp messages', async () => {
    const sms = new SmsDispatcherService();
    const whatsapp = new WhatsappDispatcherService();
    const passUrl = 'https://app.example/p/pass-1#qr=abc';

    await sms.sendSms('+919876500000', 'VISITOR_PASS_APPROVED', { pin: '123456', passUrl });
    await whatsapp.sendWhatsapp('+919876500000', 'VISITOR_PASS_APPROVED', { pin: '123456', passUrl });

    expect(sms.getMockSentStore().at(-1)?.message).toContain(passUrl);
    expect(whatsapp.getMockSentStore().at(-1)?.message).toContain(passUrl);
  });
});
