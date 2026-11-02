import { AppException } from '../src/common/app.exception';
import { publicIpRateLimit, RegistrationService } from '../src/registration/registration.service';
import * as config from '../src/config';
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
      login: jest.fn(),
      refresh: jest.fn(),
      changePassword: jest.fn(),
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
      reset: jest.fn().mockResolvedValue(undefined),
      decrement: jest.fn().mockResolvedValue(undefined),
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
      society: jest.fn().mockResolvedValue({
        societyId: SOCIETY_ID,
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
    it('successfully registers a new resident user with membership pending administrator approval', async () => {
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
          status: 'PENDING_APPROVAL',
        }),
      });
      expect(mockPrisma.residentFlatMembership.create).not.toHaveBeenCalled();
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

    it('rejects registration if phone number already exists', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'existing-phone-id', phone: '+91 99999 11111' });

      await expect(
        registrationService.registerUser({
          name: 'Duplicate Phone User',
          email: 'newemail@example.com',
          phone: '+91 99999 11111',
          password: 'Password#2026',
          societyId: SOCIETY_ID,
        }),
      ).rejects.toThrow(AppException);
    });

    it('rejects registration if flat belongs to a different society', async () => {
      mockPrisma.flat.findUnique.mockResolvedValueOnce({
        id: 'other-flat-id',
        flatNumber: '999',
        building: { societyId: 'diff-society-uuid', name: 'Other Tower' },
      });

      await expect(
        registrationService.registerUser({
          name: 'Wrong Flat User',
          email: 'wrongflat@example.com',
          password: 'Password#2026',
          societyId: SOCIETY_ID,
          flatId: 'other-flat-id',
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
    it('marks self-registered relative as PENDING_APPROVAL and omits plaintext credentials', async () => {
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
            settings: { approvalCategories: ['RELATIVE', 'DELIVERY', 'CAB'], maxPassDurationHours: 24, maxUsesPerPass: 5, maxPassesPerFlatPerDay: 20 },
          },
        },
      });

      mockPrisma.visitorPass.create.mockResolvedValueOnce({
        id: 'pass-uuid-1',
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        hostUserId: USER_ID,
        visitorId: VISITOR_ID,
        category: 'RELATIVE',
        status: 'PENDING_APPROVAL',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 72 * 3600 * 1000),
        maxUses: 5,
        usedCount: 0,
        visitor: { id: VISITOR_ID, name: 'Ramesh Patel [MH 02 CZ 4411]', phone: '+91 98765 00000' },
      });

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
      expect(result.status).toBe('PENDING_APPROVAL');
      expect(result.credentials).toBeNull();
      expect(result.requiresHostApproval).toBe(true);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            template: 'VISITOR_SELF_REGISTERED',
          }),
        }),
      );
    });

    it('requires host approval when self-registering for FRIEND or OTHER categories even if not in society approvalCategories', async () => {
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
            settings: { approvalCategories: ['DELIVERY'], maxPassDurationHours: 24, maxUsesPerPass: 5, maxPassesPerFlatPerDay: 20 },
          },
        },
      });

      mockPrisma.visitorPass.create.mockResolvedValueOnce({
        id: 'pass-friend-1',
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        hostUserId: USER_ID,
        visitorId: VISITOR_ID,
        category: 'FRIEND',
        status: 'PENDING_APPROVAL',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 4 * 3600 * 1000),
        maxUses: 1,
        usedCount: 0,
        visitor: { id: VISITOR_ID, name: 'Close Friend', phone: '+91 98765 33333' },
      });

      const result = await registrationService.selfRegisterVisitor({
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        visitorName: 'Close Friend',
        category: 'FRIEND',
      });

      expect(result.status).toBe('PENDING_APPROVAL');
      expect(result.requiresHostApproval).toBe(true);
      expect(result.credentials).toBeNull();
    });


    it('marks self-registration as PENDING_APPROVAL even when category is excluded from approval policy (replaced auto-approves assertion)', async () => {
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
            settings: { approvalCategories: ['DELIVERY'], maxPassDurationHours: 24, maxUsesPerPass: 5, maxPassesPerFlatPerDay: 20 },
          },
        },
      });

      mockPrisma.visitorPass.create.mockResolvedValueOnce({
        id: 'pass-active-1',
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        hostUserId: USER_ID,
        visitorId: VISITOR_ID,
        category: 'CAB',
        status: 'PENDING_APPROVAL',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 2 * 3600 * 1000),
        maxUses: 1,
        usedCount: 0,
        visitor: { id: VISITOR_ID, name: 'Uber Driver', phone: '+91 98765 11111' },
      });

      const result = await registrationService.selfRegisterVisitor({
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        visitorName: 'Uber Driver',
        category: 'CAB',
      });

      expect(result.status).toBe('PENDING_APPROVAL');
      expect(result.requiresHostApproval).toBe(true);
      expect(result.credentials).toBeNull();
    });

    it('sends generated PIN to visitor phone upon host approval and does not expose it in the approval response', async () => {
      const mockNotificationsService = {
        notifyPassApproved: jest.fn().mockResolvedValue(undefined),
        notifyPassRevoked: jest.fn().mockResolvedValue(undefined),
      };
      const { VisitorPassesService } = require('../src/visitors/visitor-passes.service');
      const passesService = new VisitorPassesService(
        mockPrisma,
        mockAuthz,
        credentialsService,
        mockAudit,
        mockNotificationsService,
      );

      mockPrisma.visitorPass.findUnique = jest.fn().mockResolvedValueOnce({
        id: 'pass-pending-1',
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        hostUserId: USER_ID,
        status: 'PENDING_APPROVAL',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 3600 * 1000),
        usedCount: 0,
        maxUses: 1,
        category: 'CAB',
        flat: { building: { societyId: SOCIETY_ID, name: 'Tower A' }, flatNumber: '101' },
      });

      mockPrisma.visitorPass.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.visitorPassCredential = {
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      };
      mockPrisma.visitorApproval = {
        create: jest.fn().mockResolvedValue({ id: 'appr-1' }),
      };
      mockPrisma.auditLog = {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      };
      mockPrisma.visitorPass.findUniqueOrThrow = jest.fn().mockResolvedValueOnce({
        id: 'pass-pending-1',
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        hostUserId: USER_ID,
        visitorId: VISITOR_ID,
        status: 'ACTIVE',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 3600 * 1000),
        maxUses: 1,
        usedCount: 0,
        category: 'CAB',
        visitor: { id: VISITOR_ID, name: 'Uber Driver', phone: '+919876511111' },
        flat: { id: FLAT_ID, flatNumber: '101', building: { name: 'Tower A' } },
        host: { id: USER_ID, name: 'Resident Host' },
        accessPoints: [{ accessPoint: { id: GATE_ID, name: 'Main Gate', type: 'BOOM_BARRIER' } }],
        createdAt: new Date(),
      });

      const approved = await passesService.approve(
        { sub: USER_ID, isPlatformAdmin: false },
        'pass-pending-1',
        { decision: 'APPROVED' },
      );

      expect(approved.status).toBe('ACTIVE');
      expect((approved as { credentials?: unknown }).credentials).toBeUndefined();
      expect(mockNotificationsService.notifyPassApproved).toHaveBeenCalledWith(
        expect.objectContaining({
          societyId: SOCIETY_ID,
          flatNumber: '101',
          visitorPhone: '+919876511111',
          pin: expect.stringMatching(/^\d{6}$/),
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

    describe('public endpoint rate limits behind a proxy in production', () => {
      afterEach(() => {
        jest.restoreAllMocks();
      });

      const useProduction = (isProduction: boolean) => {
        const realEnv = config.getEnv();
        jest.spyOn(config, 'getEnv').mockReturnValue({ ...realEnv, isProduction });
      };

      it.each(['unknown', '127.0.0.1', '::ffff:127.0.0.1'])(
        'applies the strict self-registration limit for %s in production',
        async (ip) => {
          useProduction(true);
          mockRateLimit.hit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });

          await expect(
            registrationService.selfRegisterVisitor(
              { societyId: SOCIETY_ID, flatId: FLAT_ID, visitorName: 'Proxy Visitor', category: 'RELATIVE' },
              ip,
            ),
          ).rejects.toThrow(AppException);
          expect(mockRateLimit.hit).toHaveBeenCalledWith(`visitor:self-register:ip:${ip}`, 15, 900);
        },
      );

      it('keeps the relaxed loopback limit outside production for local e2e runs', () => {
        useProduction(false);
        expect(publicIpRateLimit('127.0.0.1', 15, 500)).toBe(500);
        expect(publicIpRateLimit('unknown', 15, 500)).toBe(500);
        expect(publicIpRateLimit('203.0.113.9', 15, 500)).toBe(15);
      });

      it('applies the strict account-registration limit for loopback in production', async () => {
        useProduction(true);
        const { RegistrationController } = await import('../src/registration/registration.controller');
        const controller = new RegistrationController(registrationService, mockRateLimit);
        mockRateLimit.hit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });

        await expect(
          controller.register(
            {
              name: 'Proxy User',
              email: 'proxy@example.com',
              password: 'Password#2026',
              societyId: SOCIETY_ID,
            },
            { ip: '127.0.0.1', headers: {} } as never,
            { cookie: jest.fn() } as never,
          ),
        ).rejects.toThrow(AppException);
        expect(mockRateLimit.hit).toHaveBeenCalledWith('auth:register:ip:127.0.0.1', 10, 900);
      });
    });

    it('rejects self-registration if flat belongs to a different society', async () => {
      mockPrisma.flat.findUnique.mockResolvedValueOnce({
        id: 'wrong-flat',
        building: { societyId: 'diff-society', society: { id: 'diff-society' } },
      });

      await expect(
        registrationService.selfRegisterVisitor({
          societyId: SOCIETY_ID,
          flatId: 'wrong-flat',
          visitorName: 'Visitor',
          category: 'RELATIVE',
        }),
      ).rejects.toThrow(AppException);
    });

    it('rejects self-registration when daily pass capacity is exceeded', async () => {
      mockPrisma.visitorPass.count.mockResolvedValueOnce(25); // exceeds 20

      await expect(
        registrationService.selfRegisterVisitor({
          societyId: SOCIETY_ID,
          flatId: FLAT_ID,
          visitorName: 'Capacity Visitor',
          category: 'RELATIVE',
        }),
      ).rejects.toThrow(AppException);
    });

    it('retries on P2002 PIN collision and succeeds with new credentials on subsequent attempt', async () => {
      mockPrisma.visitorPass.create
        .mockRejectedValueOnce({ code: 'P2002', message: 'Unique constraint failed on credentialHash' })
        .mockResolvedValueOnce({
          id: 'pass-collision-retry-1',
          societyId: SOCIETY_ID,
          flatId: FLAT_ID,
          hostUserId: USER_ID,
          visitorId: VISITOR_ID,
          category: 'FRIEND',
          status: 'PENDING_APPROVAL',
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 24 * 3600 * 1000),
          maxUses: 1,
          usedCount: 0,
          visitor: { id: VISITOR_ID, name: 'Friend', phone: '+91 98765 22222' },
        });

      const result = await registrationService.selfRegisterVisitor({
        societyId: SOCIETY_ID,
        flatId: FLAT_ID,
        visitorName: 'Friend',
        category: 'FRIEND',
      });

      expect(result.passId).toBe('pass-collision-retry-1');
      expect(mockPrisma.visitorPass.create).toHaveBeenCalledTimes(2);
    });

    it('throws error when PIN collision occurs on all 5 attempts', async () => {
      mockPrisma.visitorPass.create.mockRejectedValue({
        code: 'P2002',
        message: 'Unique constraint failed on credentialHash',
      });

      await expect(
        registrationService.selfRegisterVisitor({
          societyId: SOCIETY_ID,
          flatId: FLAT_ID,
          visitorName: 'Colliding Visitor',
          category: 'FRIEND',
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(mockPrisma.visitorPass.create).toHaveBeenCalledTimes(5);
    });

    it('rejects self-registration if no active gates exist for the society', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValueOnce([]);

      await expect(
        registrationService.selfRegisterVisitor({
          societyId: SOCIETY_ID,
          flatId: FLAT_ID,
          visitorName: 'Gate Visitor',
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

    it('retries on P2002 PIN collision during relative registration and succeeds', async () => {
      mockPrisma.visitorPass.create
        .mockRejectedValueOnce({ code: 'P2002', message: 'Unique constraint failed on credentialHash' })
        .mockResolvedValueOnce({
          id: 'pass-rel-retry-1',
          societyId: SOCIETY_ID,
          flatId: FLAT_ID,
          hostUserId: USER_ID,
          visitorId: VISITOR_ID,
          category: 'RELATIVE',
          status: 'ACTIVE',
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 72 * 3600 * 1000),
          maxUses: 5,
          usedCount: 0,
        });

      const result = await relativesService.registerRelative(USER_ID, FLAT_ID, {
        name: 'Uncle Suresh',
        relation: 'Uncle',
      });

      expect(result.initialPass.id).toBe('pass-rel-retry-1');
      expect(mockPrisma.visitorPass.create).toHaveBeenCalledTimes(2);
    });

    it('rejects relative registration with duplicate name and relation for same flat', async () => {
      mockPrisma.visitor.findFirst.mockResolvedValueOnce({ id: 'existing-rel' });

      await expect(
        relativesService.registerRelative(USER_ID, FLAT_ID, {
          name: 'Kavita Patel',
          relation: 'Sister',
        }),
      ).rejects.toThrow(AppException);
    });

    it('rejects relative registration when no active gates exist', async () => {
      mockPrisma.accessPoint.findMany.mockResolvedValueOnce([]);

      await expect(
        relativesService.registerRelative(USER_ID, FLAT_ID, {
          name: 'Meena Aunt',
          relation: 'Aunt',
        }),
      ).rejects.toThrow(AppException);
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

    it('rejects quick pass if visitor does not belong to the flat (IDOR protection)', async () => {
      mockPrisma.visitorPass.findFirst.mockResolvedValueOnce(null);

      await expect(
        relativesService.issueQuickPass(USER_ID, FLAT_ID, 'other-flat-visitor-id', {
          validHours: 24,
        }),
      ).rejects.toThrow(AppException);
    });

    it('rejects quick pass if visitor is not found or not active relative', async () => {
      mockPrisma.visitor.findUnique.mockResolvedValueOnce(null);

      await expect(
        relativesService.issueQuickPass(USER_ID, FLAT_ID, 'non-existent-visitor', {
          validHours: 24,
        }),
      ).rejects.toThrow(AppException);
    });

    it('revokes active passes and unlinks relative from directory on delete', async () => {
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
      expect(mockPrisma.visitor.update).toHaveBeenCalledWith({
        where: { id: VISITOR_ID },
        data: { category: 'OTHER' },
      });
    });

    it('rejects deleting relative if relative belongs to a different flat (IDOR protection)', async () => {
      mockPrisma.visitorPass.findFirst.mockResolvedValueOnce(null);

      await expect(
        relativesService.deleteRelative(USER_ID, FLAT_ID, 'other-flat-relative-id'),
      ).rejects.toThrow(AppException);
    });
  });

  describe('Mobile Client Bearer Token Delivery (AuthController & RegistrationController)', () => {
    let authController: any;
    let regController: any;
    let mockResponse: any;

    beforeEach(async () => {
      const { AuthController } = await import('../src/auth/auth.controller');
      const { RegistrationController } = await import('../src/registration/registration.controller');

      authController = new AuthController(mockAuthService, mockRateLimit);
      regController = new RegistrationController(registrationService, mockRateLimit);
      mockResponse = {
        cookie: jest.fn(),
        clearCookie: jest.fn(),
      };
    });

    it('returns accessToken and refreshToken in body when X-Client-Type is mobile', async () => {
      mockAuthService.login.mockResolvedValueOnce({
        user: { id: USER_ID, email: 'resident@societyos.dev', name: 'Resident' },
        expiresIn: 900,
        accessToken: 'mobile-access-jwt',
        refreshToken: 'mobile-refresh-jwt',
      });

      const req = {
        ip: '127.0.0.1',
        headers: { 'x-client-type': 'mobile', 'user-agent': 'SocietyOS-Mobile/1.0' },
      };

      const result = await authController.login(
        { email: 'resident@societyos.dev', password: 'Password#123' },
        req as any,
        mockResponse,
      );

      expect(result.accessToken).toBe('mobile-access-jwt');
      expect(result.refreshToken).toBe('mobile-refresh-jwt');
      expect(result.user.email).toBe('resident@societyos.dev');
    });

    it('omits accessToken and refreshToken from body for standard web clients (cookie only)', async () => {
      mockAuthService.login.mockResolvedValueOnce({
        user: { id: USER_ID, email: 'resident@societyos.dev', name: 'Resident' },
        expiresIn: 900,
        accessToken: 'web-access-jwt',
        refreshToken: 'web-refresh-jwt',
      });

      const req = {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      };

      const result = await authController.login(
        { email: 'resident@societyos.dev', password: 'Password#123' },
        req as any,
        mockResponse,
      );

      expect(result.accessToken).toBeUndefined();
      expect(result.refreshToken).toBeUndefined();
      expect(result.user.email).toBe('resident@societyos.dev');
      expect(mockResponse.cookie).toHaveBeenCalled();
    });

    it('returns tokens on session refresh when X-Client-Type is mobile', async () => {
      mockAuthService.refresh.mockResolvedValueOnce({
        user: { id: USER_ID, email: 'resident@societyos.dev', name: 'Resident' },
        expiresIn: 900,
        accessToken: 'refreshed-mobile-access',
        refreshToken: 'refreshed-mobile-refresh',
      });

      const req = {
        ip: '127.0.0.1',
        headers: { 'x-client-type': 'mobile', 'user-agent': 'SocietyOS-Mobile/1.0' },
      };

      const result = await authController.refresh(
        { refreshToken: 'existing-mobile-refresh' },
        req as any,
        mockResponse,
      );

      expect(result.accessToken).toBe('refreshed-mobile-access');
      expect(result.refreshToken).toBe('refreshed-mobile-refresh');
    });

    it('returns tokens on changePassword when X-Client-Type is mobile', async () => {
      mockAuthService.changePassword.mockResolvedValueOnce({
        user: { id: USER_ID, email: 'resident@societyos.dev', name: 'Resident' },
        expiresIn: 900,
        accessToken: 'new-pwd-mobile-access',
        refreshToken: 'new-pwd-mobile-refresh',
      });

      const req = {
        ip: '127.0.0.1',
        headers: { 'x-client-type': 'mobile', 'user-agent': 'SocietyOS-Mobile/1.0' },
      };

      const result = await authController.changePassword(
        { sub: USER_ID, email: 'resident@societyos.dev' } as any,
        { currentPassword: 'OldPassword#123', newPassword: 'NewPassword#123' },
        req as any,
        mockResponse,
      );

      expect(result.accessToken).toBe('new-pwd-mobile-access');
      expect(result.refreshToken).toBe('new-pwd-mobile-refresh');
      expect(result.user.email).toBe('resident@societyos.dev');
    });

    it('omits tokens on changePassword for standard web clients (cookie only)', async () => {
      mockAuthService.changePassword.mockResolvedValueOnce({
        user: { id: USER_ID, email: 'resident@societyos.dev', name: 'Resident' },
        expiresIn: 900,
        accessToken: 'new-pwd-web-access',
        refreshToken: 'new-pwd-web-refresh',
      });

      const req = {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      };

      const result = await authController.changePassword(
        { sub: USER_ID, email: 'resident@societyos.dev' } as any,
        { currentPassword: 'OldPassword#123', newPassword: 'NewPassword#123' },
        req as any,
        mockResponse,
      );

      expect(result.accessToken).toBeUndefined();
      expect(result.refreshToken).toBeUndefined();
      expect(mockResponse.cookie).toHaveBeenCalled();
    });
  });
});

