import { Prisma } from '@prisma/client';
import { BiometricsService } from '../src/devices/biometrics.service';
import { GateAdapterFactory } from '../src/devices/adapters/gate-adapter.factory';

describe('Biometrics Service & DPDP Act 2023 Compliance (Unit)', () => {
  let biometricsService: BiometricsService;
  let adapterFactory: GateAdapterFactory;
  let mockPrisma: any;
  let mockAudit: any;
  let mockMqtt: any;

  beforeEach(() => {
    adapterFactory = new GateAdapterFactory();
    mockAudit = { record: jest.fn().mockResolvedValue({}) };
    mockMqtt = { publishCommand: jest.fn().mockResolvedValue({}) };

    mockPrisma = {
      societyMembership: {
        findUnique: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      accessPoint: {
        findFirst: jest.fn(),
      },
      accessEvent: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'evt-123', ...data })),
        count: jest.fn().mockResolvedValue(42),
      },
      auditLog: {
        count: jest.fn().mockResolvedValue(88),
      },
      visitor: {
        findMany: jest.fn().mockResolvedValue([{ id: 'vis-1' }, { id: 'vis-2' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      gateCommand: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: data.id, ...data })),
      },
      biometricTemplate: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    biometricsService = new BiometricsService(
      mockPrisma as any,
      mockAudit as any,
      adapterFactory,
      mockMqtt as any,
    );
  });

  it('enrolls a resident biometric template with India DPDP Act 2023 consent basis', async () => {
    mockPrisma.societyMembership.findUnique.mockResolvedValue({
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
      user: { id: 'user-1', name: 'Aarav Patel' },
    });

    const result = await biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
      userId: 'user-1',
      type: 'FACE',
      templateHash: 'sha256_mock_face_aarav_99',
      algorithm: 'SUPREMA_FACE_V3',
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe('user-1');
    expect(result.dpdpCompliance.notice).toContain('India DPDP Act 2023 compliant');
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BIOMETRIC_ENROLLED',
        societyId: 'soc-1',
        entityId: 'user-1',
      }),
    );
  });

  it('authorizes valid resident biometric scan and opens gate adapter', async () => {
    // 1. Enroll
    mockPrisma.societyMembership.findUnique.mockResolvedValue({
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
    });
    await biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
      userId: 'user-1',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_valid_777',
      algorithm: 'ZKFINGER_V10',
    });

    // 2. Mock gate and resident flat membership
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Tower A Entrance',
      type: 'DOOR_LOCK',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Aarav Patel',
      flatMemberships: [
        {
          flat: { flatNumber: 'A-101' },
          endedAt: null,
        },
      ],
    });

    // 3. Verify
    const verifyResult = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-1',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_valid_777',
    });

    expect(verifyResult.decision).toBe('AUTHORIZED');
    expect(verifyResult.reasonCode).toBe('VALID_RESIDENT_BIOMETRIC');
    expect((verifyResult as any).resident.name).toBe('Aarav Patel');
    expect('gateCommand' in verifyResult && verifyResult.gateCommand).toEqual({
      status: 'ISSUED',
      id: expect.any(String),
    });

    const adapter = adapterFactory.get('ap-gate-1');
    expect(await adapter?.getState()).toBe('OPEN');
    expect(mockPrisma.gateCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'OPEN',
          deviceId: 'dev-controller-1',
          accessPointId: 'ap-gate-1',
        }),
      }),
    );
    expect(mockMqtt.publishCommand).toHaveBeenCalled();
  });

  it('returns gateCommand status FAILED with error when GateCommand insertion fails during biometric verify', async () => {
    mockPrisma.societyMembership.findUnique.mockResolvedValue({
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
    });
    await biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
      userId: 'user-1',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_hardware_fail_111',
      algorithm: 'ZKFINGER_V10',
    });

    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Tower A Entrance',
      type: 'DOOR_LOCK',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Aarav Patel',
      flatMemberships: [
        {
          flat: { flatNumber: 'A-101' },
          endedAt: null,
        },
      ],
    });

    mockPrisma.gateCommand.create.mockRejectedValueOnce(new Error('PostgreSQL command write failed'));

    const verifyResult = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-1',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_hardware_fail_111',
    });

    expect(verifyResult.decision).toBe('AUTHORIZED');
    expect(verifyResult.reasonCode).toBe('VALID_RESIDENT_BIOMETRIC');
    expect('gateCommand' in verifyResult && verifyResult.gateCommand).toEqual({
      status: 'FAILED',
      error: 'PostgreSQL command write failed',
    });
    expect(mockMqtt.publishCommand).not.toHaveBeenCalled();
  });

  it('returns gateCommand status FAILED with error when MQTT publish fails during biometric verify', async () => {
    mockPrisma.societyMembership.findUnique.mockResolvedValue({
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
    });
    await biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
      userId: 'user-1',
      type: 'FACE',
      templateHash: 'face_hash_mqtt_fail_222',
      algorithm: 'SUPREMA_FACE_V3',
    });

    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Tower A Entrance',
      type: 'DOOR_LOCK',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Aarav Patel',
      flatMemberships: [
        {
          flat: { flatNumber: 'A-101' },
          endedAt: null,
        },
      ],
    });

    mockMqtt.publishCommand.mockRejectedValueOnce(new Error('MQTT broker connection refused'));

    const verifyResult = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-1',
      type: 'FACE',
      templateHash: 'face_hash_mqtt_fail_222',
    });

    expect(verifyResult.decision).toBe('AUTHORIZED');
    expect(verifyResult.reasonCode).toBe('VALID_RESIDENT_BIOMETRIC');
    expect('gateCommand' in verifyResult && verifyResult.gateCommand).toEqual({
      status: 'FAILED',
      error: 'MQTT broker connection refused',
    });
  });

  it('returns gateCommand status FAILED when access point has no devices assigned during biometric verify', async () => {
    mockPrisma.societyMembership.findUnique.mockResolvedValue({
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
    });
    await biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
      userId: 'user-1',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_nodevice_333',
      algorithm: 'ZKFINGER_V10',
    });

    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-standalone',
      name: 'Gate Without Hardware Controller',
      type: 'DOOR_LOCK',
      societyId: 'soc-1',
      devices: [],
    });

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Aarav Patel',
      flatMemberships: [
        {
          flat: { flatNumber: 'A-101' },
          endedAt: null,
        },
      ],
    });

    const verifyResult = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-standalone',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_nodevice_333',
    });

    expect(verifyResult.decision).toBe('AUTHORIZED');
    expect(verifyResult.reasonCode).toBe('VALID_RESIDENT_BIOMETRIC');
    expect('gateCommand' in verifyResult && verifyResult.gateCommand).toEqual({
      status: 'FAILED',
      error: 'No active device configured for access point',
    });
    expect(mockMqtt.publishCommand).not.toHaveBeenCalled();
  });

  it('denies unknown biometric templates with audit record', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Tower A Entrance',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    const verifyResult = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-1',
      type: 'FACE',
      templateHash: 'unknown_stranger_face_hash',
    });

    expect(verifyResult.decision).toBe('DENIED');
    expect(verifyResult.reasonCode).toBe('BIOMETRIC_NOT_RECOGNIZED');
  });

  it('triggers emergency override, sets gate to OPEN and records audit log', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    const overrideResult = await biometricsService.triggerEmergencyOverride(
      'soc-1',
      'guard-user-1',
      'GUARD',
      'ap-gate-1',
      'Ambulance arrival at North Gate',
    );

    expect(overrideResult.success).toBe(true);
    expect(overrideResult.decision).toBe('AUTHORIZED');
    expect(overrideResult.reasonCode).toBe('EMERGENCY_OVERRIDE');
    expect(overrideResult.gateState).toBe('OPEN');
    expect(mockPrisma.gateCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'OPEN',
          deviceId: 'dev-controller-1',
          accessPointId: 'ap-gate-1',
        }),
      }),
    );
    expect(mockMqtt.publishCommand).toHaveBeenCalled();
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_OVERRIDE',
        societyId: 'soc-1',
      }),
    );
  });

  it('resets emergency override, sets gate to CLOSED and records reset audit log', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    const resetResult = await biometricsService.resetEmergencyOverride(
      'soc-1',
      'guard-user-1',
      'GUARD',
      'ap-gate-1',
      'Emergency hold released by security',
    );

    expect(resetResult.success).toBe(true);
    expect(resetResult.decision).toBe('AUTHORIZED');
    expect(resetResult.reasonCode).toBe('EMERGENCY_RESET');
    expect(resetResult.gateState).toBe('CLOSED');
    expect(mockPrisma.gateCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'CLOSE',
          deviceId: 'dev-controller-1',
          accessPointId: 'ap-gate-1',
        }),
      }),
    );
    expect(mockMqtt.publishCommand).toHaveBeenCalled();
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_RESET',
        societyId: 'soc-1',
      }),
    );
  });

  it('does not publish MQTT command when GateCommand insertion fails in triggerEmergencyOverride and fails the request', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });
    mockPrisma.gateCommand.create.mockRejectedValueOnce(new Error('Database write failure'));

    await expect(
      biometricsService.triggerEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-1',
        'Fire alarm trigger',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency override command');

    expect(mockMqtt.publishCommand).not.toHaveBeenCalled();
  });

  it('does not publish MQTT command when GateCommand insertion fails in resetEmergencyOverride and fails the request', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });
    mockPrisma.gateCommand.create.mockRejectedValueOnce(new Error('Database write failure'));

    await expect(
      biometricsService.resetEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-1',
        'Fire alarm cleared',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency reset command');

    expect(mockMqtt.publishCommand).not.toHaveBeenCalled();
  });

  it('fails emergency override request when no devices are assigned to the access point', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Standalone Gate Without Devices',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [],
    });

    await expect(
      biometricsService.triggerEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-1',
        'Ambulance arrival',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency override command');

    expect(mockMqtt.publishCommand).not.toHaveBeenCalled();
  });

  it('records AccessEvent and audit entry and leaves adapter state unchanged when triggerEmergencyOverride dispatch fails', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });
    mockPrisma.gateCommand.create.mockRejectedValueOnce(new Error('Hardware controller offline'));

    const adapter = adapterFactory.getOrCreate('ap-gate-1', 'Main Perimeter Boom Barrier', 'BOOM_BARRIER');
    expect(await adapter.getState()).toBe('CLOSED');

    await expect(
      biometricsService.triggerEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-1',
        'Fire alarm trigger',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency override command');

    // Gate adapter state must remain unchanged (CLOSED, not OPEN)
    expect(await adapter.getState()).toBe('CLOSED');
    const telemetry = await adapter.getTelemetry();
    expect(telemetry.emergencyActive).toBe(false);

    // Must record AccessEvent with DENIED and EMERGENCY_DISPATCH_FAILED
    expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          societyId: 'soc-1',
          accessPointId: 'ap-gate-1',
          decision: 'DENIED',
          reasonCode: 'EMERGENCY_DISPATCH_FAILED',
          meta: expect.objectContaining({
            deviceResults: [
              expect.objectContaining({
                deviceId: 'dev-controller-1',
                status: 'FAILED',
                error: 'Hardware controller offline',
              }),
            ],
          }),
        }),
      }),
    );

    // Must record audit log for the failed attempt
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_OVERRIDE',
        societyId: 'soc-1',
        meta: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
  });

  it('records AccessEvent and audit entry and leaves adapter state unchanged when resetEmergencyOverride dispatch fails', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    const adapter = adapterFactory.getOrCreate('ap-gate-1', 'Main Perimeter Boom Barrier', 'BOOM_BARRIER');
    await adapter.emergencyOverride('Prior emergency');
    expect(await adapter.getState()).toBe('OPEN');
    expect((await adapter.getTelemetry()).emergencyActive).toBe(true);

    mockPrisma.gateCommand.create.mockRejectedValueOnce(new Error('Reset dispatch bus error'));

    await expect(
      biometricsService.resetEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-1',
        'Clear emergency',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency reset command');

    // Gate adapter state must remain in emergency (OPEN, emergencyActive: true)
    expect(await adapter.getState()).toBe('OPEN');
    expect((await adapter.getTelemetry()).emergencyActive).toBe(true);

    // Must record AccessEvent with DENIED and EMERGENCY_DISPATCH_FAILED
    expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          societyId: 'soc-1',
          accessPointId: 'ap-gate-1',
          decision: 'DENIED',
          reasonCode: 'EMERGENCY_DISPATCH_FAILED',
          meta: expect.objectContaining({
            deviceResults: [
              expect.objectContaining({
                deviceId: 'dev-controller-1',
                status: 'FAILED',
                error: 'Reset dispatch bus error',
              }),
            ],
          }),
        }),
      }),
    );

    // Must record audit log for the failed reset attempt
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_RESET',
        societyId: 'soc-1',
        meta: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
  });

  it('records AccessEvent and audit entry when triggerEmergencyOverride fails due to no devices', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-standalone',
      name: 'Gate Without Devices',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [],
    });

    const adapter = adapterFactory.getOrCreate('ap-gate-standalone', 'Gate Without Devices', 'BOOM_BARRIER');
    expect(await adapter.getState()).toBe('CLOSED');

    await expect(
      biometricsService.triggerEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-standalone',
        'Fire drill',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency override command');

    expect(await adapter.getState()).toBe('CLOSED');
    expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'DENIED',
          reasonCode: 'EMERGENCY_DISPATCH_FAILED',
          meta: expect.objectContaining({
            deviceResults: [],
          }),
        }),
      }),
    );
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_OVERRIDE',
        meta: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
  });

  it('records AccessEvent and audit entry and leaves adapter state unchanged when resetEmergencyOverride fails due to no devices', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-standalone-reset',
      name: 'Gate Without Devices Reset',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [],
    });

    const adapter = adapterFactory.getOrCreate('ap-gate-standalone-reset', 'Gate Without Devices Reset', 'BOOM_BARRIER');
    await adapter.emergencyOverride('Prior emergency');
    expect(await adapter.getState()).toBe('OPEN');
    expect((await adapter.getTelemetry()).emergencyActive).toBe(true);

    await expect(
      biometricsService.resetEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-standalone-reset',
        'Reset drill',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency reset command');

    expect(await adapter.getState()).toBe('OPEN');
    expect((await adapter.getTelemetry()).emergencyActive).toBe(true);
    expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'DENIED',
          reasonCode: 'EMERGENCY_DISPATCH_FAILED',
          meta: expect.objectContaining({
            deviceResults: [],
          }),
        }),
      }),
    );
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_RESET',
        meta: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
  });

  it('records audit entry and throws COMMAND_DISPATCH_FAILED even if accessEvent creation fails during triggerEmergencyOverride failure', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });
    mockPrisma.gateCommand.create.mockRejectedValueOnce(new Error('Hardware offline'));
    mockPrisma.accessEvent.create.mockRejectedValueOnce(new Error('AccessEvent database connection lost'));

    await expect(
      biometricsService.triggerEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-1',
        'Fire drill failure',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency override command');

    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_OVERRIDE',
        societyId: 'soc-1',
        meta: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
  });

  it('records audit entry and throws COMMAND_DISPATCH_FAILED even if accessEvent creation fails during resetEmergencyOverride failure', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Main Perimeter Boom Barrier',
      type: 'BOOM_BARRIER',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });
    mockPrisma.gateCommand.create.mockRejectedValueOnce(new Error('Reset bus error'));
    mockPrisma.accessEvent.create.mockRejectedValueOnce(new Error('AccessEvent database connection lost'));

    await expect(
      biometricsService.resetEmergencyOverride(
        'soc-1',
        'guard-user-1',
        'GUARD',
        'ap-gate-1',
        'Reset drill failure',
      ),
    ).rejects.toThrow('No active gate controller device received the emergency reset command');

    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GATE_EMERGENCY_RESET',
        societyId: 'soc-1',
        meta: expect.objectContaining({
          status: 'FAILED',
        }),
      }),
    );
  });

  it('loads persisted biometric template from database on cache miss', async () => {
    mockPrisma.biometricTemplate.findFirst.mockResolvedValueOnce({
      id: 'bt-persisted-1',
      societyId: 'soc-1',
      userId: 'user-db-1',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_from_db_123',
      algorithm: 'SUPREMA_V2',
      consentGivenAt: new Date(),
      lawfulBasis: 'DPDP_2023_SECTION_6_EXPLICIT_CONSENT',
    });

    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Tower A Entrance',
      type: 'DOOR_LOCK',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-db-1',
      name: 'Priya Sharma',
      flatMemberships: [
        {
          flat: { flatNumber: 'B-202' },
          endedAt: null,
        },
      ],
    });

    const verifyResult = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-1',
      type: 'FINGERPRINT',
      templateHash: 'finger_hash_from_db_123',
    });

    expect(verifyResult.decision).toBe('AUTHORIZED');
    expect(verifyResult.reasonCode).toBe('VALID_RESIDENT_BIOMETRIC');
    expect((verifyResult as any).resident.name).toBe('Priya Sharma');
  });

  it('rejects biometric enrollment when explicit DPDP consent is withheld', async () => {
    mockPrisma.societyMembership.findUnique.mockResolvedValue({
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
    });

    await expect(
      biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
        userId: 'user-1',
        type: 'FACE',
        templateHash: 'sha256_mock_face_no_consent',
        algorithm: 'SUPREMA_FACE_V3',
        consentGiven: false,
      }),
    ).rejects.toThrow();
  });

  it('generates DPDP compliance report and anonymizes expired visitor data', async () => {
    const report = await biometricsService.getDpdpComplianceReport('soc-1');
    expect(report.complianceStandard).toContain('Digital Personal Data Protection Act, 2023');
    expect(report.principles.dataMinimization).toContain('COMPLIANT');
    expect(report.metrics.totalAccessLogsAudited).toBe(42);

    const anonResult = await biometricsService.anonymizeExpiredVisitorData('soc-1', 90);
    expect(anonResult.status).toBe('SUCCESS');
    expect(anonResult.anonymizedCount).toBe(2);
    expect(mockPrisma.visitor.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'ANONYMIZED_VISITOR', phone: null },
      }),
    );
  });

  it('explicitly rejects synthetic biometric values (BIO_RESIDENT_*, FINGERPRINT_RESIDENT_*) when not enrolled', async () => {
    mockPrisma.accessPoint.findFirst.mockResolvedValue({
      id: 'ap-gate-1',
      name: 'Tower A Entrance',
      type: 'DOOR_LOCK',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    });

    const resultBio = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-1',
      type: 'FINGERPRINT',
      templateHash: 'BIO_RESIDENT_user-123',
    });
    expect(resultBio.decision).toBe('DENIED');
    expect(resultBio.reasonCode).toBe('BIOMETRIC_NOT_RECOGNIZED');

    const resultFinger = await biometricsService.verifyResidentBiometric('soc-1', {
      accessPointId: 'ap-gate-1',
      type: 'FINGERPRINT',
      templateHash: 'FINGERPRINT_RESIDENT_101',
    });
    expect(resultFinger.decision).toBe('DENIED');
    expect(resultFinger.reasonCode).toBe('BIOMETRIC_NOT_RECOGNIZED');
  });

  it('fails biometric enrollment and propagates error if BiometricTemplate persistence fails', async () => {
    mockPrisma.societyMembership.findUnique.mockResolvedValue({
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
      user: { id: 'user-1', name: 'Aarav Patel' },
    });
    mockPrisma.biometricTemplate.upsert.mockRejectedValueOnce(
      new Error('BiometricTemplate table constraint failure'),
    );

    await expect(
      biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
        userId: 'user-1',
        type: 'FINGERPRINT',
        templateHash: 'sha256_mock_fail',
        algorithm: 'ZKFINGER_V10',
      }),
    ).rejects.toThrow('BiometricTemplate table constraint failure');
  });

  describe('tenant isolation & persistence regressions', () => {
    const activeMembership = {
      id: 'mem-1',
      societyId: 'soc-1',
      userId: 'user-1',
      status: 'ACTIVE',
    };
    const gate = {
      id: 'ap-gate-1',
      name: 'Tower A Entrance',
      type: 'DOOR_LOCK',
      societyId: 'soc-1',
      devices: [{ deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } }],
    };

    it('denies a resident whose only active flat is in another society', async () => {
      mockPrisma.societyMembership.findUnique.mockResolvedValue(activeMembership);
      await biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
        userId: 'user-1',
        type: 'FINGERPRINT',
        templateHash: 'finger_hash_moved_out_555',
        algorithm: 'ZKFINGER_V10',
      });
      mockPrisma.accessPoint.findFirst.mockResolvedValue(gate);
      // Emulate the database: only flat memberships matching the requested filter are returned.
      const memberships = [
        { endedAt: null, flat: { flatNumber: 'Z-9', building: { societyId: 'soc-2' } } },
      ];
      mockPrisma.user.findUnique.mockImplementation(
        (args: { include: { flatMemberships: { where: { flat?: { building?: { societyId?: string } } } } } }) => {
          const wanted = args.include.flatMemberships.where.flat?.building?.societyId;
          return Promise.resolve({
            id: 'user-1',
            name: 'Moved Out',
            flatMemberships: memberships.filter(
              (m) => wanted === undefined || m.flat.building.societyId === wanted,
            ),
          });
        },
      );

      const result = await biometricsService.verifyResidentBiometric('soc-1', {
        accessPointId: 'ap-gate-1',
        type: 'FINGERPRINT',
        templateHash: 'finger_hash_moved_out_555',
      });

      expect(result.decision).toBe('DENIED');
      expect(result.reasonCode).toBe('RESIDENT_MEMBERSHIP_INACTIVE');
      expect(mockPrisma.gateCommand.create).not.toHaveBeenCalled();
      expect(mockMqtt.publishCommand).not.toHaveBeenCalled();
    });

    it('refuses to re-home a template already enrolled by another society', async () => {
      mockPrisma.societyMembership.findUnique.mockResolvedValue(activeMembership);
      mockPrisma.biometricTemplate.upsert.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on template_hash', {
          code: 'P2002',
          clientVersion: '6.16.0',
          meta: { target: ['template_hash'] },
        }),
      );

      await expect(
        biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
          userId: 'user-1',
          type: 'FACE',
          templateHash: 'face_hash_owned_by_soc_2',
          algorithm: 'SUPREMA_FACE_V3',
        }),
      ).rejects.toMatchObject({ code: 'BIOMETRIC_TEMPLATE_CONFLICT', status: 409 });

      const upsertArgs = mockPrisma.biometricTemplate.upsert.mock.calls[0][0];
      expect(upsertArgs.where).toEqual({ templateHash: 'face_hash_owned_by_soc_2', societyId: 'soc-1' });
      expect(upsertArgs.update).not.toHaveProperty('societyId');
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('does not authorize a template whose enrollment failed to persist', async () => {
      mockPrisma.societyMembership.findUnique.mockResolvedValue(activeMembership);
      mockPrisma.biometricTemplate.upsert.mockRejectedValueOnce(new Error('database unavailable'));
      await expect(
        biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
          userId: 'user-1',
          type: 'FINGERPRINT',
          templateHash: 'finger_hash_not_persisted_1',
          algorithm: 'ZKFINGER_V10',
        }),
      ).rejects.toThrow('database unavailable');

      mockPrisma.accessPoint.findFirst.mockResolvedValue(gate);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        name: 'Aarav Patel',
        flatMemberships: [{ flat: { flatNumber: 'A-101' }, endedAt: null }],
      });

      const result = await biometricsService.verifyResidentBiometric('soc-1', {
        accessPointId: 'ap-gate-1',
        type: 'FINGERPRINT',
        templateHash: 'finger_hash_not_persisted_1',
      });

      expect(result.decision).toBe('DENIED');
      expect(result.reasonCode).toBe('BIOMETRIC_NOT_RECOGNIZED');
      expect(mockPrisma.gateCommand.create).not.toHaveBeenCalled();
    });

    it('actuates the requesting reader and records its device and request ids', async () => {
      mockPrisma.societyMembership.findUnique.mockResolvedValue(activeMembership);
      await biometricsService.enrollResidentBiometric('admin-1', 'soc-1', {
        userId: 'user-1',
        type: 'FACE',
        templateHash: 'face_hash_reader_origin_1',
        algorithm: 'SUPREMA_FACE_V3',
      });
      mockPrisma.accessPoint.findFirst.mockResolvedValue({
        ...gate,
        devices: [
          { deviceId: 'dev-controller-1', device: { id: 'dev-controller-1' } },
          { deviceId: 'dev-reader-2', device: { id: 'dev-reader-2' } },
        ],
      });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        name: 'Aarav Patel',
        flatMemberships: [{ flat: { flatNumber: 'A-101' }, endedAt: null }],
      });

      const result = await biometricsService.verifyResidentBiometric(
        'soc-1',
        { accessPointId: 'ap-gate-1', type: 'FACE', templateHash: 'face_hash_reader_origin_1' },
        { deviceId: 'dev-reader-2', requestId: 'req-reader-1' },
      );

      expect(result.decision).toBe('AUTHORIZED');
      expect(mockPrisma.gateCommand.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deviceId: 'dev-reader-2' }) }),
      );
      expect(mockPrisma.accessEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deviceId: 'dev-reader-2', requestId: 'req-reader-1' }),
        }),
      );
    });

    it('keeps visitors with a pass still inside the retention window when anonymizing', async () => {
      const before = Date.now();
      const result = await biometricsService.anonymizeExpiredVisitorData('soc-1', 90);

      expect(result.anonymizedCount).toBe(2);
      expect(mockPrisma.visitor.findMany).not.toHaveBeenCalled();
      const args = mockPrisma.visitor.updateMany.mock.calls[0][0];
      expect(args.where.societyId).toBe('soc-1');
      const cutoff: Date = args.where.createdAt.lt;
      expect(args.where.passes).toEqual({ none: { validUntil: { gte: cutoff } } });
      expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(90 * 24 * 3600 * 1000 - 1000);
    });
  });
});
