import { AppException } from '../src/common/app.exception';
import { DeviceApiController } from '../src/devices/device-api.controller';
import { AuthedRequest } from '../src/auth/jwt-auth.guard';

describe('Device Edge Synchronization & Bounded Offline Policy Suite (Stage 5)', () => {
  const SOCIETY_ID = 'soc-111-aaa';
  const DEVICE_ID = 'dev-222-bbb';
  const AP_GATE_1 = 'ap-gate-1';
  const AP_GATE_2 = 'ap-gate-2';
  const FOREIGN_AP = 'ap-foreign-soc';

  let controller: DeviceApiController;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      device: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      visitorPass: {
        findMany: jest.fn(),
      },
      residentFlatMembership: {
        findMany: jest.fn(),
      },
      accessPoint: {
        findMany: jest.fn(),
      },
      accessEvent: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'evt-1', ...data })),
      },
      deviceEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'dev-evt-1', ...data })),
      },
      deviceAccessPoint: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation((cb) => {
        if (typeof cb === 'function') {
          return cb(mockPrisma);
        }
        return Promise.all(cb);
      }),
    };

    controller = new DeviceApiController(mockPrisma as any);
  });

  const mockDeviceReq = {
    device: {
      id: DEVICE_ID,
      societyId: SOCIETY_ID,
      name: 'Main Gate Virtual Controller',
    },
  } as unknown as AuthedRequest;

  describe('GET /device-api/edge-sync', () => {
    it('returns active resident biometric templates and approved passes for assigned gates', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({
        id: DEVICE_ID,
        accessPoints: [{ accessPointId: AP_GATE_1 }],
      });

      const now = Date.now();
      mockPrisma.visitorPass.findMany.mockResolvedValue([
        {
          id: 'pass-1',
          usedCount: 0,
          maxUses: 1,
          validFrom: new Date(now - 1000),
          validUntil: new Date(now + 86400_000),
          visitor: { name: 'Arjun Mehta' },
          flat: { flatNumber: '101', building: { name: 'Tower A' } },
          credentials: [
            { credentialHash: 'hash-pin-123456', type: 'PIN' },
          ],
        },
      ]);

      mockPrisma.residentFlatMembership.findMany.mockResolvedValue([
        {
          userId: 'res-user-1',
          user: { id: 'res-user-1', name: 'Rohan Sharma' },
          flat: { flatNumber: '202', building: { name: 'Tower B' } },
        },
      ]);

      const res = await controller.edgeSync(mockDeviceReq);

      expect(res.ok).toBe(true);
      expect(res.societyId).toBe(SOCIETY_ID);
      expect(res.deviceId).toBe(DEVICE_ID);
      expect(res.assignedAccessPoints).toEqual([AP_GATE_1]);
      expect(res.policy.offlineValidityWindowHours).toBe(24);
      expect(res.policy.maxOfflineEvents).toBe(500);

      // Verify credentials contain both resident biometric template and visitor PIN
      const resBiometric = res.credentials.find((c: any) => c.kind === 'BIOMETRIC');
      expect(resBiometric).toBeDefined();
      expect(resBiometric!.credentialHash).toBe('BIO_RESIDENT_res-user-1');
      expect(resBiometric!.visitorName).toContain('Rohan Sharma (Resident)');

      const visitorCred = res.credentials.find((c: any) => c.kind === 'PIN');
      expect(visitorCred).toBeDefined();
      expect(visitorCred!.credentialHash).toBe('hash-pin-123456');
      expect(visitorCred!.visitorName).toBe('Arjun Mehta');
      expect(visitorCred!.flatNumber).toBe('Tower A · 101');
    });

    it('filters out passes that have already reached maxUses', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({
        id: DEVICE_ID,
        accessPoints: [{ accessPointId: AP_GATE_1 }],
      });

      mockPrisma.visitorPass.findMany.mockResolvedValue([
        {
          id: 'pass-exhausted',
          usedCount: 2,
          maxUses: 2,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 3600_000),
          visitor: { name: 'Exhausted Guest' },
          flat: { flatNumber: '101', building: { name: 'Tower A' } },
          credentials: [{ credentialHash: 'hash-exhausted', type: 'PIN' }],
        },
      ]);

      mockPrisma.residentFlatMembership.findMany.mockResolvedValue([]);

      const res = await controller.edgeSync(mockDeviceReq);
      expect(res.credentials.length).toBe(0);
    });
  });

  describe('POST /device-api/sync-offline', () => {
    it('successfully resynchronizes a batch of buffered offline events into ledger', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);

      const events: any[] = [
        {
          sequence: 1,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
        },
        {
          sequence: 2,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'DENIED',
          reasonCode: 'PASS_EXHAUSTED',
          timestamp: new Date().toISOString(),
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });

      expect(res.ok).toBe(true);
      expect(res.syncedCount).toBe(2);
      expect(mockPrisma.accessEvent.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.deviceEvent.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.device.update).toHaveBeenCalledWith({
        where: { id: DEVICE_ID },
        data: { lastSeenAt: expect.any(Date) },
      });
    });

    it('rejects batches exceeding 500 events to protect database resources', async () => {
      const hugeBatch = new Array(501).fill({
        sequence: 1,
        accessPointId: AP_GATE_1,
        credentialType: 'PIN',
        decision: 'AUTHORIZED',
        reasonCode: 'OK',
        timestamp: new Date().toISOString(),
      });

      await expect(
        controller.syncOffline(mockDeviceReq, { events: hugeBatch }),
      ).rejects.toThrow(AppException);
    });

    it('ignores events for access points not belonging to the society', async () => {
      // AP_GATE_1 belongs to society, FOREIGN_AP does not
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);

      const events: any[] = [
        {
          sequence: 1,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
        },
        {
          sequence: 2,
          accessPointId: FOREIGN_AP,
          credentialType: 'PIN',
          decision: 'DENIED',
          reasonCode: 'INVALID',
          timestamp: new Date().toISOString(),
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });

      expect(res.ok).toBe(true);
      expect(res.syncedCount).toBe(1); // Only the valid AP was ingested
      expect(mockPrisma.accessEvent.create).toHaveBeenCalledTimes(1);
    });

    it('detects and bounds future clock drift to preserve audit log chronology', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);

      const futureTime = new Date(Date.now() + 7200_000).toISOString(); // 2 hours ahead
      const events: any[] = [
        {
          sequence: 10,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: futureTime,
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });
      expect(res.ok).toBe(true);
      expect(res.syncedCount).toBe(1);
      expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meta: expect.objectContaining({
              clockDriftDetected: true,
              reportedTimestamp: futureTime,
            }),
          }),
        }),
      );
    });

    it('deduplicates replayed events by sequence to prevent duplicate ledger records', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);
      // Simulate that sequence 1 was already processed
      mockPrisma.deviceEvent.findFirst
        .mockResolvedValueOnce({ id: 'existing-event' }) // seq 1 exists
        .mockResolvedValueOnce(null); // seq 2 is new

      const events: any[] = [
        {
          sequence: 1,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
        },
        {
          sequence: 2,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });
      expect(res.ok).toBe(true);
      expect(res.syncedCount).toBe(1);
      expect(res.duplicateCount).toBe(1);
      expect(mockPrisma.accessEvent.create).toHaveBeenCalledTimes(1);
    });
  });
});
