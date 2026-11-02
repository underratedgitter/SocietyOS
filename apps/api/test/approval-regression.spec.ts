import { Prisma } from '@prisma/client';
import { CredentialsService } from '../src/visitors/credentials.service';
import { VisitorPassesService } from '../src/visitors/visitor-passes.service';
import { RegistrationService } from '../src/registration/registration.service';
import { AuthService } from '../src/auth/auth.service';
import { RateLimitService } from '../src/common/rate-limit.service';
import { JwtUser } from '../src/auth/jwt-auth.guard';

describe('A1: Visitor Pass Approval Regression Suite', () => {
  const SOCIETY_ID = '11111111-1111-1111-1111-111111111111';
  const FLAT_ID = '22222222-2222-2222-2222-222222222222';
  const USER_ID = '33333333-3333-3333-3333-333333333333';
  const VISITOR_ID = '44444444-4444-4444-4444-444444444444';
  const PASS_ID = 'pass-uuid-101';

  let credentialsService: CredentialsService;
  let mockPrisma: any;
  let mockAuthz: any;
  let mockAudit: any;
  let mockNotifications: any;
  let passesService: VisitorPassesService;

  const caller: JwtUser = {
    sub: USER_ID,
    email: 'resident@example.com',
    name: 'Resident Host',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  beforeEach(() => {
    credentialsService = new CredentialsService();
    mockAuthz = {
      society: jest.fn().mockResolvedValue({ role: 'RESIDENT', societyId: SOCIETY_ID }),
      flat: jest.fn().mockResolvedValue({ role: 'RESIDENT', societyId: SOCIETY_ID, flat: { flatNumber: '101' } }),
    };
    mockAudit = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    mockNotifications = {
      notifyPassApproved: jest.fn().mockResolvedValue(undefined),
      notifyPassRevoked: jest.fn().mockResolvedValue(undefined),
    };

    mockPrisma = {
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      visitorPass: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      visitorPassCredential: {
        count: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      visitorApproval: {
        create: jest.fn().mockResolvedValue({ id: 'appr-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      residentFlatMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rfm-1', flatId: FLAT_ID, userId: USER_ID }),
      },
    };

    passesService = new VisitorPassesService(
      mockPrisma,
      mockAuthz,
      credentialsService,
      mockAudit,
      mockNotifications,
    );
  });

  const basePassIncludeResult = (visitorPhone: string | null = '+919876500000', status = 'ACTIVE') => ({
    id: PASS_ID,
    societyId: SOCIETY_ID,
    flatId: FLAT_ID,
    hostUserId: USER_ID,
    visitorId: VISITOR_ID,
    status,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 3600 * 1000),
    maxUses: 1,
    usedCount: 0,
    category: 'DELIVERY',
    visitor: { id: VISITOR_ID, name: 'Delivery Partner', phone: visitorPhone },
    flat: { id: FLAT_ID, flatNumber: '101', building: { name: 'Tower A' } },
    host: { id: USER_ID, name: 'Resident Host' },
    accessPoints: [{ accessPoint: { id: 'ap-1', name: 'Main Gate', type: 'BOOM_BARRIER' } }],
    createdAt: new Date(),
  });

  it('(a) approving a host-created pending pass keeps the original credential hashes', async () => {
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'PENDING_APPROVAL',
      category: 'DELIVERY',
    });

    // Pass already has 2 credentials (e.g. host-created pass)
    mockPrisma.visitorPassCredential.count.mockResolvedValueOnce(2);
    mockPrisma.visitorPass.findUniqueOrThrow.mockResolvedValueOnce(basePassIncludeResult());

    const result = await passesService.approve(caller, PASS_ID, { decision: 'APPROVED' });

    expect(result.status).toBe('ACTIVE');
    // Must NOT delete existing credentials
    expect(mockPrisma.visitorPassCredential.deleteMany).not.toHaveBeenCalled();
    // Must NOT create new credentials over existing ones
    expect(mockPrisma.visitorPassCredential.createMany).not.toHaveBeenCalled();
    // Credentials hashes remain untouched, no plaintext credentials in response
    expect(result.credentials).toBeUndefined();
  });

  it('(b) approving a self-registered pass creates credentials exactly once (with visitor phone)', async () => {
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'PENDING_APPROVAL',
      category: 'RELATIVE',
    });

    // Pass has NO credentials (self-registered)
    mockPrisma.visitorPassCredential.count.mockResolvedValueOnce(0);
    mockPrisma.visitorPass.findUniqueOrThrow.mockResolvedValueOnce(
      basePassIncludeResult('+919876543210'),
    );

    const result = await passesService.approve(caller, PASS_ID, { decision: 'APPROVED' });

    expect(result.status).toBe('ACTIVE');
    // Credentials created exactly once
    expect(mockPrisma.visitorPassCredential.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visitorPassCredential.deleteMany).not.toHaveBeenCalled();

    // Plaintext credentials delivered via notifications to visitor phone
    expect(mockNotifications.notifyPassApproved).toHaveBeenCalledWith(
      expect.objectContaining({
        visitorPhone: '+919876543210',
        pin: expect.stringMatching(/^\d{6}$/),
      }),
    );
    // Not returned to host
    expect(result.credentials).toBeUndefined();
  });

  it('(b2) approving a self-registered pass when visitor has no phone returns credentials to host and records in audit log', async () => {
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'PENDING_APPROVAL',
      category: 'RELATIVE',
    });

    // Pass has NO credentials
    mockPrisma.visitorPassCredential.count.mockResolvedValueOnce(0);
    // Visitor has NO phone number on file
    mockPrisma.visitorPass.findUniqueOrThrow.mockResolvedValueOnce(
      basePassIncludeResult(null),
    );

    const result = await passesService.approve(caller, PASS_ID, { decision: 'APPROVED' });

    expect(result.status).toBe('ACTIVE');
    // Credentials created exactly once
    expect(mockPrisma.visitorPassCredential.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visitorPassCredential.deleteMany).not.toHaveBeenCalled();

    // Plaintext credentials returned to approving host
    expect(result.credentials).toBeDefined();
    expect(result.credentials?.pin).toMatch(/^\d{6}$/);
    expect(typeof result.credentials?.qrToken).toBe('string');

    // Audit log records that credentials were returned to host
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'VISITOR_PASS_APPROVED',
          meta: expect.objectContaining({
            credentialsReturnedToHost: true,
          }),
        }),
      }),
    );
  });

  it('(c) a second approval attempt is rejected', async () => {
    // Already ACTIVE (approved previously)
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'ACTIVE',
      category: 'DELIVERY',
    });

    await expect(
      passesService.approve(caller, PASS_ID, { decision: 'APPROVED' }),
    ).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });

    // Also test race condition where status was PENDING_APPROVAL on read but updateMany found 0 rows
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'PENDING_APPROVAL',
      category: 'DELIVERY',
    });
    mockPrisma.visitorPass.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      passesService.approve(caller, PASS_ID, { decision: 'APPROVED' }),
    ).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });
  });

  it('retries the PIN on a P2002 collision during approval like create() does', async () => {
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'PENDING_APPROVAL',
      category: 'RELATIVE',
    });

    const collisionError = new Prisma.PrismaClientKnownRequestError('collision', {
      code: 'P2002',
      clientVersion: '6.16.0',
      meta: { target: ['societyId', 'credentialHash'] },
    });

    // First attempt: count=0, createMany fails with P2002
    // Second attempt: count=0, createMany succeeds
    mockPrisma.visitorPassCredential.count.mockResolvedValue(0);
    mockPrisma.visitorPassCredential.createMany
      .mockRejectedValueOnce(collisionError)
      .mockResolvedValueOnce({ count: 2 });

    mockPrisma.visitorPass.findUniqueOrThrow.mockResolvedValue(basePassIncludeResult());

    const result = await passesService.approve(caller, PASS_ID, { decision: 'APPROVED' });

    expect(result.status).toBe('ACTIVE');
    expect(mockPrisma.visitorPassCredential.createMany).toHaveBeenCalledTimes(2);
  });

  it('selfRegisterVisitor creates the pass with NO credentials', async () => {
    const mockRateLimit = { hit: jest.fn().mockResolvedValue({ allowed: true }) };
    const mockAuth = {};
    const regService = new RegistrationService(
      mockPrisma,
      mockAuth as unknown as AuthService,
      credentialsService,
      mockRateLimit as unknown as RateLimitService,
      mockAudit,
    );

    mockPrisma.flat = {
      findUnique: jest.fn().mockResolvedValue({
        id: FLAT_ID,
        building: {
          societyId: SOCIETY_ID,
          name: 'Tower A',
          society: { id: SOCIETY_ID, name: 'Palm Grove', settings: {} },
        },
        flatNumber: '101',
      }),
    };
    mockPrisma.visitor = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: VISITOR_ID }),
    };
    mockPrisma.accessPoint = {
      findMany: jest.fn().mockResolvedValue([{ id: 'ap-1', name: 'Main Gate', type: 'BOOM_BARRIER' }]),
    };
    mockPrisma.residentFlatMembership = {
      findFirst: jest.fn().mockResolvedValue({ userId: USER_ID }),
    };
    mockPrisma.notification = {
      create: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    };
    mockPrisma.visitorPass.create = jest.fn().mockResolvedValue({
      id: PASS_ID,
      status: 'PENDING_APPROVAL',
      category: 'RELATIVE',
      validFrom: new Date(),
      validUntil: new Date(),
      maxUses: 1,
      visitor: { id: VISITOR_ID, name: 'Guest', phone: '+919999999999' },
    });

    const res = await regService.selfRegisterVisitor({
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      visitorName: 'Guest',
      category: 'RELATIVE',
    });

    expect(res.credentials).toBeNull();
    const createData = mockPrisma.visitorPass.create.mock.calls[0][0].data;
    expect(createData.credentials).toBeUndefined();
  });

  it('rejecting a pending pass revokes it without generating credentials and notifies visitor/host', async () => {
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'PENDING_APPROVAL',
      category: 'DELIVERY',
    });

    mockPrisma.visitorPass.findUniqueOrThrow.mockResolvedValueOnce(
      basePassIncludeResult('+919876543210', 'REVOKED'),
    );

    const result = await passesService.approve(caller, PASS_ID, {
      decision: 'REJECTED',
      reason: 'Unrecognized delivery agent',
    });

    expect(result.status).toBe('REVOKED');
    expect(mockPrisma.visitorPassCredential.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.visitorPassCredential.deleteMany).not.toHaveBeenCalled();
    expect(mockNotifications.notifyPassRevoked).toHaveBeenCalledWith(
      expect.objectContaining({
        passId: PASS_ID,
        visitorName: 'Delivery Partner',
      }),
    );
    expect(mockPrisma.visitorApproval.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'REJECTED',
          reason: 'Unrecognized delivery agent',
        }),
      }),
    );
  });

  it('treats whitespace-only visitor phone as missing phone and returns credentials to approving host', async () => {
    mockPrisma.visitorPass.findUnique.mockResolvedValueOnce({
      id: PASS_ID,
      societyId: SOCIETY_ID,
      flatId: FLAT_ID,
      hostUserId: USER_ID,
      status: 'PENDING_APPROVAL',
      category: 'RELATIVE',
    });

    mockPrisma.visitorPassCredential.count.mockResolvedValueOnce(0);
    mockPrisma.visitorPass.findUniqueOrThrow.mockResolvedValueOnce(
      basePassIncludeResult('   '),
    );

    const result = await passesService.approve(caller, PASS_ID, { decision: 'APPROVED' });

    expect(result.status).toBe('ACTIVE');
    expect(result.credentials).toBeDefined();
    expect(result.credentials?.pin).toMatch(/^\d{6}$/);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'VISITOR_PASS_APPROVED',
          meta: expect.objectContaining({
            credentialsReturnedToHost: true,
          }),
        }),
      }),
    );
  });
});
