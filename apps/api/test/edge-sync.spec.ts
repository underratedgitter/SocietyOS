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
        findMany: jest.fn().mockResolvedValue([]),
      },
      residentFlatMembership: {
        findMany: jest.fn().mockResolvedValue([]),
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
      biometricTemplate: {
        findMany: jest.fn().mockResolvedValue([]),
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

      mockPrisma.biometricTemplate.findMany.mockResolvedValue([
        {
          templateHash: 'real_enrolled_template_hash_1',
          user: {
            id: 'res-user-1',
            name: 'Rohan Sharma',
            flatMemberships: [
              { flat: { flatNumber: '202', building: { name: 'Tower B' } } },
            ],
          },
        },
      ]);

      const res = await controller.edgeSync(mockDeviceReq);

      expect(res.ok).toBe(true);
      expect(res.societyId).toBe(SOCIETY_ID);
      expect(res.deviceId).toBe(DEVICE_ID);
      expect(res.assignedAccessPoints).toEqual([AP_GATE_1]);
      expect(res.policy.offlineValidityWindowHours).toBe(24);
      expect(res.policy.maxOfflineEvents).toBe(500);

      // Verify credentials contain real enrolled resident biometric template (not synthetic BIO_RESIDENT_)
      const resBiometric = res.credentials.find((c: any) => c.kind === 'BIOMETRIC');
      expect(resBiometric).toBeDefined();
      expect(resBiometric!.credentialHash).toBe('real_enrolled_template_hash_1');
      expect(resBiometric!.visitorName).toContain('Rohan Sharma (Resident)');
      expect(resBiometric!.flatNumber).toBe('Tower B · 202');

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

      mockPrisma.biometricTemplate.findMany.mockResolvedValue([]);

      const res = await controller.edgeSync(mockDeviceReq);
      expect(res.credentials.length).toBe(0);
    });

    it('returns revoked pass credential hashes and ended resident template hashes in revokedHashes', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({
        id: DEVICE_ID,
        accessPoints: [{ accessPointId: AP_GATE_1 }],
      });

      mockPrisma.visitorPass.findMany
        .mockResolvedValueOnce([]) // active passes
        .mockResolvedValueOnce([  // revoked passes
          {
            id: 'pass-revoked-1',
            credentials: [{ credentialHash: 'hash-revoked-pin' }],
          },
        ]);

      mockPrisma.residentFlatMembership.findMany.mockResolvedValueOnce([{ userId: 'ex-resident-99' }]); // ended residents
      mockPrisma.biometricTemplate.findMany
        .mockResolvedValueOnce([]) // active resident templates
        .mockResolvedValueOnce([{ templateHash: 'revoked-bio-template-hash-99' }]); // ended resident templates

      const res = await controller.edgeSync(mockDeviceReq);
      expect(res.ok).toBe(true);
      expect(res.revokedHashes).toContain('hash-revoked-pin');
      expect(res.revokedHashes).toContain('revoked-bio-template-hash-99');
      expect(res.revokedHashes).not.toContain('BIO_RESIDENT_ex-resident-99');
    });

    it('edgeSync queries only enrolled templates with consent and never outputs synthetic BIO_RESIDENT_ IDs', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({
        id: DEVICE_ID,
        accessPoints: [{ accessPointId: AP_GATE_1 }],
      });

      mockPrisma.visitorPass.findMany.mockResolvedValue([]);
      mockPrisma.biometricTemplate.findMany.mockResolvedValue([]);
      mockPrisma.residentFlatMembership.findMany.mockResolvedValue([]);

      const res = await controller.edgeSync(mockDeviceReq);
      expect(res.ok).toBe(true);
      expect(mockPrisma.biometricTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            societyId: SOCIETY_ID,
            consentGivenAt: expect.any(Object),
            user: expect.objectContaining({
              memberships: { some: { societyId: SOCIETY_ID, status: 'ACTIVE' } },
              flatMemberships: {
                some: {
                  flat: { building: { societyId: SOCIETY_ID } },
                  endedAt: null,
                },
              },
            }),
          }),
        }),
      );
      for (const cred of res.credentials) {
        expect(cred.credentialHash).not.toMatch(/^BIO_RESIDENT_/);
      }
    });

    it('bounds revoked passes to validity window (validUntil > now - 1 day) and memberships to last 30 days with limit', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({
        id: DEVICE_ID,
        accessPoints: [{ accessPointId: AP_GATE_1 }],
      });

      mockPrisma.visitorPass.findMany
        .mockResolvedValueOnce([]) // active passes
        .mockResolvedValueOnce([]); // revoked passes

      mockPrisma.biometricTemplate.findMany.mockResolvedValue([]);
      mockPrisma.residentFlatMembership.findMany.mockResolvedValue([]);

      const res = await controller.edgeSync(mockDeviceReq);
      expect(res.ok).toBe(true);

      // Verify revoked passes queried with validUntil > now - 1 day and take limit
      expect(mockPrisma.visitorPass.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            societyId: SOCIETY_ID,
            validUntil: { gt: expect.any(Date) },
          }),
          take: 1000,
        }),
      );

      // Verify ended residents queried with endedAt >= 30 days ago and take limit
      expect(mockPrisma.residentFlatMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            endedAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
          take: 1000,
        }),
      );
    });

    it('does not include active resident biometric template in revokedHashes even if an older flat membership ended in the last 30 days', async () => {
      mockPrisma.device.findUnique.mockResolvedValue({
        id: DEVICE_ID,
        accessPoints: [{ accessPointId: AP_GATE_1 }],
      });

      mockPrisma.visitorPass.findMany
        .mockResolvedValueOnce([]) // active passes
        .mockResolvedValueOnce([]); // revoked passes

      // Active resident template
      mockPrisma.biometricTemplate.findMany
        .mockResolvedValueOnce([
          {
            templateHash: 'active-resident-template-hash',
            user: {
              id: 'res-user-moving',
              name: 'Moving Resident',
              flatMemberships: [
                { flat: { flatNumber: '202', building: { name: 'Tower B' } } },
              ],
            },
          },
        ])
        // Ended templates query returns the same template hash
        .mockResolvedValueOnce([
          { templateHash: 'active-resident-template-hash' },
        ]);

      // Previous flat membership ended 5 days ago
      mockPrisma.residentFlatMembership.findMany.mockResolvedValueOnce([
        { userId: 'res-user-moving' },
      ]);

      const res = await controller.edgeSync(mockDeviceReq);
      expect(res.ok).toBe(true);
      const activeBio = res.credentials.find((c: any) => c.credentialHash === 'active-resident-template-hash');
      expect(activeBio).toBeDefined();
      expect(res.revokedHashes).not.toContain('active-resident-template-hash');
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

    it('synchronizes offline pass usage and increments usedCount', async () => {
      const PASS_UUID = 'e0000000-0000-4000-a000-000000000001';
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);
      mockPrisma.visitorPass = {
        ...mockPrisma.visitorPass,
        findUnique: jest.fn().mockResolvedValue({ id: PASS_UUID, societyId: SOCIETY_ID, usedCount: 1, maxUses: 3, status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({ id: PASS_UUID, usedCount: 2 }),
      };

      const events: any[] = [
        {
          sequence: 101,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
          passId: PASS_UUID,
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });
      expect(res.ok).toBe(true);
      expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            passId: PASS_UUID,
            decision: 'AUTHORIZED',
          }),
        }),
      );
      expect(mockPrisma.visitorPass.update).toHaveBeenCalledWith({
        where: { id: PASS_UUID },
        data: expect.objectContaining({ usedCount: 2 }),
      });
    });

    it('ignores passIds owned by another society and never mutates them', async () => {
      const FOREIGN_PASS_UUID = 'e0000000-0000-4000-a000-000000000002';
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);
      mockPrisma.visitorPass = {
        ...mockPrisma.visitorPass,
        findUnique: jest.fn().mockResolvedValue({
          id: FOREIGN_PASS_UUID,
          societyId: 'soc-other-tenant',
          usedCount: 0,
          maxUses: 1,
          status: 'ACTIVE',
        }),
        update: jest.fn(),
      };

      const events: any[] = [
        {
          sequence: 102,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
          passId: FOREIGN_PASS_UUID,
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });
      expect(res.syncedCount).toBe(1);
      expect(mockPrisma.visitorPass.update).not.toHaveBeenCalled();
      expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passId: undefined, societyId: SOCIETY_ID }),
        }),
      );
    });

    it('verifies device-to-access-point assignment in query to prevent forging events for unassigned gates (Issue 4)', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValue([]); // Device is not assigned to this AP

      const events: any[] = [
        {
          sequence: 50,
          accessPointId: 'unassigned-gate',
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'FORGED_GATE',
          timestamp: new Date().toISOString(),
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });
      expect(res.syncedCount).toBe(0);
      expect(mockPrisma.accessPoint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            devices: { some: { deviceId: DEVICE_ID } },
          }),
        }),
      );
    });

    it('handles unique constraint violation gracefully on concurrent sequence replay (Issue 8)', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);
      mockPrisma.deviceEvent.findFirst.mockResolvedValue(null); // Passed initial check
      mockPrisma.deviceEvent.create.mockRejectedValueOnce({
        code: 'P2002',
        message: 'Unique constraint failed on DeviceEvent(deviceId, sequence)',
      });

      const events: any[] = [
        {
          sequence: 99,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
        },
      ];

      const res = await controller.syncOffline(mockDeviceReq, { events });
      expect(res.ok).toBe(true);
      expect(res.syncedCount).toBe(0);
      expect(res.duplicateCount).toBe(1);
      expect(mockPrisma.accessEvent.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate sequences within the same batch payload to prevent repeated pass consumption', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValue([{ id: AP_GATE_1 }]);
      mockPrisma.deviceEvent.findFirst.mockResolvedValue(null);

      const events: any[] = [
        {
          sequence: 15,
          accessPointId: AP_GATE_1,
          credentialType: 'PIN',
          decision: 'AUTHORIZED',
          reasonCode: 'VALID_OFFLINE_CACHE',
          timestamp: new Date().toISOString(),
        },
        {
          sequence: 15,
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

  describe('POST /device-api/events retry handling', () => {
    it('returns existing event on duplicate sequence retry rather than throwing 500', async () => {
      mockPrisma.deviceEvent.findFirst.mockResolvedValueOnce({ id: 'existing-event-99' });

      const res = await controller.events(mockDeviceReq, {
        type: 'ACK',
        sequence: 42,
        payload: { commandId: 'cmd-1' },
      });

      expect(res.ok).toBe(true);
      expect(res.eventId).toBe('existing-event-99');
      expect(res.duplicate).toBe(true);
      expect(mockPrisma.deviceEvent.create).not.toHaveBeenCalled();
    });

    it('gracefully handles P2002 race condition on concurrent sequence retry', async () => {
      mockPrisma.deviceEvent.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'existing-event-100' });

      mockPrisma.deviceEvent.create.mockRejectedValueOnce({
        code: 'P2002',
        message: 'Unique constraint failed on DeviceEvent(deviceId, sequence)',
      });

      const res = await controller.events(mockDeviceReq, {
        type: 'ACK',
        sequence: 43,
        payload: { commandId: 'cmd-2' },
      });

      expect(res.ok).toBe(true);
      expect(res.eventId).toBe('existing-event-100');
      expect(res.duplicate).toBe(true);
    });
  });
});

