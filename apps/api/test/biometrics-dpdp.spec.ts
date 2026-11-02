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
});

