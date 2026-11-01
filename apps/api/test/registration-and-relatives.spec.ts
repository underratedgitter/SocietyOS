import { AppException } from '../src/common/app.exception';
import { RegistrationService } from '../src/registration/registration.service';
import { RelativesService } from '../src/relatives/relatives.service';
import { CredentialsService } from '../src/visitors/credentials.service';
import { RateLimitService } from '../src/common/rate-limit.service';
import { AuditService } from '../src/common/audit.service';
import { AuthService } from '../src/auth/auth.service';
import { AuthzService } from '../src/common/authz.service';

describe('Registration & Relatives Service Modules', () => {
  const SOCIETY_ID = '11111111-1111-1111-1111-111111111111';
  const FLAT_ID = '22222222-2222-2222-2222-222222222222';
  const BUILDING_ID = '33333333-3333-3333-3333-333333333333';
  const USER_ID = '44444444-4444-4444-4444-444444444444';
  const VISITOR_ID = '55555555-5555-5555-5555-555555555555';
  const GATE_ID = '66666666-6666-6666-6666-666666666666';

  let mockPrisma: any;
  let mockAuthService: any;
  let credentialsService: CredentialsService;
  let mockRateLimit: any;
  let mockAudit: any;
  let mockAuthz: any;
  let registrationService: RegistrationService;
  let relativesService: RelativesService;

  beforeEach(() => {
    process.env.CREDENTIAL_HMAC_KEY = 'test-secret-at-least-32-chars-long-123456';
    process.env.CREDENTIAL_HMAC_KEY_ID = 'v1';

    mockPrisma = {
      society: {
        findMany: jest.fn().mockResolvedValue([
          { id: SOCIETY_ID, name: 'Palm Grove', slug: 'palm-grove', timezone: 'Asia/Kolkata' },
        ]),
        findUnique: jest.fn().mockResolvedValue({
          id: SOCIETY_ID,
          name: 'Palm Grove',
          settings: {
            approvalCategories: ['DELIVERY', 'CAB'],
            maxPassDurationHours: 24,
            maxUsesPerPass: 5,
            maxPassesPerFlatPerDay: 20,
          },
        }),
      },
      flat: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: FLAT_ID,
            buildingId: BUILDING_ID,
            flatNumber: '101',
            building: { id: BUILDING_ID, name: 'Tower A' },
          },
        ]),
        findUnique: jest.fn().mockResolvedValue({
          id: FLAT_ID,
          buildingId: BUILDING_ID,
          flatNumber: '101',
          building: { id: BUILDING_ID, name: 'Tower A', societyId: SOCIETY_ID, society: { id: SOCIETY_ID, name: 'Palm Grove', settings: null } },
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: USER_ID,
          name: 'Sunil Patel',
          email: 'sunil@example.com',
          phone: '+91 99999 11111',
          isPlatformAdmin: false,
          mustChangePassword: false,
        }),
      },
      societyMembership: {
        create: jest.fn().mockResolvedValue({ id: 'mem-1' }),
        findFirst: jest.fn().mockResolvedValue({ userId: 'admin-1' }),
      },
      residentFlatMembership: {
        create: jest.fn().mockResolvedValue({ id: 'rfm-1' }),
        findFirst: jest.fn().mockResolvedValue({ userId: USER_ID }),
      },
      visitor: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          id: VISITOR_ID,
          societyId: SOCIETY_ID,
          name: 'Ramesh Patel (Father)',
          phone: '+91 98765 00000',
          category: 'RELATIVE',
        }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({
          id: VISITOR_ID,
          societyId: SOCIETY_ID,
          name: 'Ramesh Patel (Father)',
          phone: '+91 98765 00000',
          category: 'RELATIVE',
          createdAt: new Date(),
        }),
        update: jest.fn().mockResolvedValue({
          id: VISITOR_ID,
          category: 'OTHER',
        }),
      },
      visitorPass: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({
          id: 'pass-uuid-1',
          flatId: FLAT_ID,
          visitorId: VISITOR_ID,
        }),
        create: jest.fn().mockResolvedValue({
          id: 'pass-uuid-1',
          societyId: SOCIETY_ID,
          flatId: FLAT_ID,
          hostUserId: USER_ID,
          visitorId: VISITOR_ID,
          category: 'RELATIVE',
          status: 'ACTIVE',
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 24 * 3600 * 1000),
          maxUses: 5,
          usedCount: 0,
          flat: { building: { name: 'Tower A' }, flatNumber: '101' },
          visitor: { id: VISITOR_ID, name: 'Ramesh Patel (Father)', phone: '+91 98765 00000' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      accessPoint: {
        findMany: jest.fn().mockResolvedValue([
          { id: GATE_ID, name: 'Main Gate Barrier', type: 'BOOM_BARRIER' },
        ]),
      },
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notif-1' }),
      },
      $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
    };

    mockAuthService = {
      issueSessionTokens: jest.fn().mockResolvedValue({
        accessToken: 'mock_at',
        refreshToken: 'mock_rt',
        expiresIn: 900,
      }),
      toSafeUser: jest.fn((u: any) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        isPlatformAdmin: u.isPlatformAdmin,
        mustChangePassword: u.mustChangePassword,
      })),
    };

    credentialsService = new CredentialsService();
    mockRateLimit = {
      hit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() }),
    };
    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    mockAuthz = {
      flat: jest.fn().mockResolvedValue({
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        userId: USER_ID,
        role: 'RESIDENT',
      }),
    };

    registrationService = new RegistrationService(
      mockPrisma,
      mockAuthService,
      credentialsService,
      mockRateLimit,
      mockAudit,
    );

    relativesService = new RelativesService(
      mockPrisma,
      mockAuthz,
      credentialsService,
    );
  });

  describe('User Registration (Public self signup)', () => {
    it('successfully registers a new resident user with flat link and issues auth session', async () => {
      const result = await registrationService.registerUser({
        name: 'Sunil Patel',
        email: 'sunil@example.com',
        password: 'Password#2026',
        phone: '+91 99999 11111',
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        relationship: 'OWNER',
      });

      expect(result.user.email).toBe('sunil@example.com');
      expect(result.tokens.accessToken).toBe('mock_at');
      expect(result.society.name).toBe('Palm Grove');
      expect(result.flat?.flatNumber).toBe('101');
      expect(mockPrisma.user.create).toHaveBeenCalled();
      expect(mockPrisma.societyMembership.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: 'RESIDENT',
          status: 'ACTIVE',
        }),
      });
      expect(mockPrisma.residentFlatMembership.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          relationship: 'OWNER',
        }),
      });
    });

    it('rejects registration if email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'existing-id' });

      await expect(
        registrationService.registerUser({
          name: 'Duplicate User',
          email: 'duplicate@example.com',
          password: 'Password#2026',
          societyId: SOCIETY_ID,
        }),
      ).rejects.toThrow(AppException);
    });

    it('rejects registration if society does not exist', async () => {
      mockPrisma.society.findUnique.mockResolvedValueOnce(null);

      await expect(
        registrationService.registerUser({
          name: 'No Society User',
          email: 'nosoc@example.com',
          password: 'Password#2026',
          societyId: 'non-existent-uuid',
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('Visitor & Relative Self-Registration (Public gate check-in)', () => {
    it('successfully self-registers a relative, auto-approving and returning PIN + QR credentials', async () => {
      const result = await registrationService.selfRegisterVisitor({
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        visitorName: 'Ramesh Patel',
        visitorPhone: '+91 98765 00000',
        category: 'RELATIVE',
        vehicle: 'MH 02 CZ 4411',
        purpose: 'Weekend family stay',
      });

      expect(result.passId).toBe('pass-uuid-1');
      expect(result.status).toBe('ACTIVE');
      expect(result.credentials.pin).toHaveLength(6);
      expect(result.credentials.qrToken).toBeTruthy();
      expect(result.requiresHostApproval).toBe(false);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            template: 'VISITOR_SELF_REGISTERED',
          }),
        }),
      );
    });

    it('marks delivery / cab partner pass as PENDING_APPROVAL per society policy', async () => {
      mockPrisma.flat.findUnique.mockResolvedValueOnce({
        id: FLAT_ID,
        buildingId: BUILDING_ID,
        flatNumber: '101',
        building: {
          id: BUILDING_ID,
          name: 'Tower A',
          societyId: SOCIETY_ID,
          society: {
            id: SOCIETY_ID,
            name: 'Palm Grove',
            settings: { approvalCategories: ['DELIVERY', 'CAB'], maxPassDurationHours: 24, maxUsesPerPass: 5, maxPassesPerFlatPerDay: 20 },
          },
        },
      });

      mockPrisma.visitorPass.create.mockResolvedValueOnce({
        id: 'pass-del-1',
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        hostUserId: USER_ID,
        visitorId: VISITOR_ID,
        category: 'DELIVERY',
        status: 'PENDING_APPROVAL',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 30 * 60 * 1000),
        maxUses: 1,
        usedCount: 0,
        visitor: { id: VISITOR_ID, name: 'Zomato Partner', phone: '+91 99999 88888' },
      });

      const result = await registrationService.selfRegisterVisitor({
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        visitorName: 'Zomato Partner',
        category: 'DELIVERY',
      });

      expect(result.requiresHostApproval).toBe(true);
    });

    it('rejects self-registration when rate limit is exceeded', async () => {
      mockRateLimit.hit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });

      await expect(
        registrationService.selfRegisterVisitor({
          societyId: SOCIETY_ID,
          flatId: FLAT_ID,
          visitorName: 'Spam Visitor',
          category: 'RELATIVE',
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('Resident Relatives Management & Quick Pass Generation', () => {
    it('registers a relative with automatic initial entry pass', async () => {
      const result = await relativesService.registerRelative(USER_ID, FLAT_ID, {
        name: 'Kavita Patel',
        relation: 'Sister',
        phone: '+91 98200 12345',
        defaultVehicle: 'MH 04 AB 9988',
        notes: 'Frequent visitor for festivals and holidays',
      });

      expect(result.relative.name).toBe('Kavita Patel');
      expect(result.relative.relation).toBe('Sister');
      expect(result.initialPass.credentials.pin).toHaveLength(6);
      expect(result.initialPass.credentials.qrToken).toBeTruthy();
    });

    it('issues a fast 1-click entry pass for a registered relative', async () => {
      const result = await relativesService.issueQuickPass(USER_ID, FLAT_ID, VISITOR_ID, {
        validHours: 48,
        maxUses: 3,
      });

      expect(result.pass.id).toBe('pass-uuid-1');
      expect(result.credentials.pin).toHaveLength(6);
      expect(result.credentials.qrToken).toBeTruthy();
      expect(mockPrisma.visitorPass.create).toHaveBeenCalled();
    });

    it('revokes active passes when a relative is removed', async () => {
      const result = await relativesService.deleteRelative(USER_ID, FLAT_ID, VISITOR_ID);
      expect(result.ok).toBe(true);
      expect(mockPrisma.visitorPass.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            flatId: FLAT_ID,
            visitorId: VISITOR_ID,
            status: 'ACTIVE',
          }),
          data: expect.objectContaining({
            status: 'REVOKED',
          }),
        }),
      );
    });
  });
});
