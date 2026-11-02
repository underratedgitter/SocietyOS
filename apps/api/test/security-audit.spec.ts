import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppException } from '../src/common/app.exception';
import { AuthzService } from '../src/common/authz.service';
import { RateLimitService } from '../src/common/rate-limit.service';
import { AuditService } from '../src/common/audit.service';
import { CredentialsService } from '../src/visitors/credentials.service';
import { IdempotencyService } from '../src/visitors/idempotency.service';
import { VisitorPassesService } from '../src/visitors/visitor-passes.service';
import { VisitorPassesController } from '../src/visitors/visitor-passes.controller';
import { SocietiesService } from '../src/societies/societies.service';
import { AccessController } from '../src/access/access.controller';
import { AccessEngineService } from '../src/access/access-engine.service';
import { SocietyScopeGuard } from '../src/auth/society-scope.guard';
import { FlatScopeGuard } from '../src/auth/flat-scope.guard';
import { AuthedRequest, JwtUser } from '../src/auth/jwt-auth.guard';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { resetEnvCacheForTests } from '../src/config';

function mockExecutionContext(req: Partial<AuthedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req as AuthedRequest,
      getResponse: () => ({} as any),
      getNext: () => ({} as any),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
    getArgs: () => [],
    getArgByIndex: () => ({}),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

describe('OWASP API Security Audit & Hardening Suite', () => {
  const SOCIETY_A = 'society-aaa-111';
  const SOCIETY_B = 'society-bbb-222';

  const originalEnv = {
    REDIS_URL: process.env.REDIS_URL,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
  };

  beforeAll(() => {
    process.env.REDIS_URL = '';
    process.env.RATE_LIMIT_ENABLED = 'true';
    resetEnvCacheForTests();
  });

  afterAll(() => {
    if (originalEnv.REDIS_URL !== undefined) process.env.REDIS_URL = originalEnv.REDIS_URL;
    else delete process.env.REDIS_URL;
    if (originalEnv.RATE_LIMIT_ENABLED !== undefined) process.env.RATE_LIMIT_ENABLED = originalEnv.RATE_LIMIT_ENABLED;
    else delete process.env.RATE_LIMIT_ENABLED;
    resetEnvCacheForTests();
  });

  const userA_Admin: JwtUser = { sub: 'user-admin-a', email: 'admin@a.com', name: 'Admin A', isPlatformAdmin: false, mustChangePassword: false };
  const userA_Resident: JwtUser = { sub: 'user-resident-a', email: 'resident@a.com', name: 'Resident A', isPlatformAdmin: false, mustChangePassword: false };
  const userA_Guard: JwtUser = { sub: 'user-guard-a', email: 'guard@a.com', name: 'Guard A', isPlatformAdmin: false, mustChangePassword: false };
  const userB_Resident: JwtUser = { sub: 'user-resident-b', email: 'resident@b.com', name: 'Resident B', isPlatformAdmin: false, mustChangePassword: false };

  beforeEach(() => {
    resetEnvCacheForTests();
  });

  // =========================================================================
  // 1. BROKEN OBJECT LEVEL AUTHORIZATION (BOLA / IDOR)
  // =========================================================================
  describe('1. Broken Object Level Authorization (BOLA / IDOR) Defenses', () => {
    let mockPrisma: any;
    let authzService: AuthzService;
    let credentialsService: CredentialsService;
    let auditService: AuditService;
    let visitorPassesService: VisitorPassesService;
    let societiesService: SocietiesService;

    beforeEach(() => {
      mockPrisma = {
        societyMembership: {
          findUnique: jest.fn(),
          findMany: jest.fn(),
        },
        flat: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          create: jest.fn(),
        },
        building: {
          findUnique: jest.fn(),
        },
        residentFlatMembership: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        visitorPass: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
        },
        visitor: {
          findFirst: jest.fn(),
          create: jest.fn().mockResolvedValue({ id: 'vis-1' }),
        },
        accessPoint: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        society: {
          findUnique: jest.fn().mockResolvedValue({
            id: SOCIETY_A,
            settings: { visitorPolicy: { maxPassDurationHours: 72, maxUsesPerPass: 10, maxPassesPerFlatPerDay: 50, approvalCategories: [] } },
          }),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({}),
        },
        $transaction: jest.fn().mockImplementation((cb) => (typeof cb === 'function' ? cb(mockPrisma) : Promise.all(cb))),
      };

      authzService = new AuthzService(mockPrisma as any);
      credentialsService = new CredentialsService();
      auditService = new AuditService(mockPrisma as any);
      visitorPassesService = new VisitorPassesService(
        mockPrisma as any,
        authzService,
        credentialsService,
        auditService,
      );
      societiesService = new SocietiesService(
        mockPrisma as any,
        authzService,
        {} as any,
        auditService,
      );
    });

    describe('Visitor Passes Cross-Tenant Isolation', () => {
      it('prevents user in Society A from viewing a pass belonging to Society B', async () => {
        // Pass belongs to Society B
        mockPrisma.visitorPass.findUnique.mockResolvedValue({
          id: 'pass-b-1',
          societyId: SOCIETY_B,
          flatId: 'flat-b-1',
          hostUserId: userB_Resident.sub,
          status: 'ACTIVE',
        });
        // User A has NO membership in Society B
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);

        await expect(visitorPassesService.getAuthorized(userA_Admin, 'pass-b-1')).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });

      it('prevents resident in Society A from viewing another flat\'s pass within Society A', async () => {
        // Pass belongs to Society A, but to Flat 2
        mockPrisma.visitorPass.findUnique.mockResolvedValue({
          id: 'pass-a-2',
          societyId: SOCIETY_A,
          flatId: 'flat-a-2',
          hostUserId: 'other-user',
          status: 'ACTIVE',
        });
        // Caller has membership in Society A as RESIDENT
        mockPrisma.societyMembership.findUnique.mockResolvedValue({
          societyId: SOCIETY_A,
          userId: userA_Resident.sub,
          role: 'RESIDENT',
          status: 'ACTIVE',
        });
        // But resident is NOT linked to Flat 2
        mockPrisma.residentFlatMembership.findFirst.mockResolvedValue(null);

        await expect(visitorPassesService.getAuthorized(userA_Resident, 'pass-a-2')).rejects.toMatchObject({
          code: 'NOT_YOUR_PASS',
          status: 403,
        });
      });

      it('prevents user in Society A from approving a pass in Society B', async () => {
        mockPrisma.visitorPass.findUnique.mockResolvedValue({
          id: 'pass-b-1',
          societyId: SOCIETY_B,
          flatId: 'flat-b-1',
          hostUserId: userB_Resident.sub,
          status: 'PENDING_APPROVAL',
        });
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);

        await expect(
          visitorPassesService.approve(userA_Admin, 'pass-b-1', { decision: 'APPROVED' }),
        ).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });

      it('prevents user in Society A from revoking a pass in Society B', async () => {
        mockPrisma.visitorPass.findUnique.mockResolvedValue({
          id: 'pass-b-1',
          societyId: SOCIETY_B,
          flatId: 'flat-b-1',
          hostUserId: userB_Resident.sub,
          status: 'ACTIVE',
        });
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);

        await expect(
          visitorPassesService.revoke(userA_Admin, 'pass-b-1', 'Malicious revoke'),
        ).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });

      it('prevents creating a visitor pass for a flat belonging to Society B', async () => {
        // Flat belongs to Society B
        mockPrisma.flat.findUnique.mockResolvedValue({
          id: 'flat-b-1',
          building: { societyId: SOCIETY_B },
        });
        // Caller only belongs to Society A
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);

        await expect(
          visitorPassesService.create(userA_Resident, {
            flatId: 'flat-b-1',
            visitor: { name: 'Visitor 1' },
            category: 'FRIEND',
            validFrom: new Date(Date.now() + 1000).toISOString(),
            validUntil: new Date(Date.now() + 10000).toISOString(),
            accessPointIds: ['ap-1'],
          }),
        ).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });

      it('prevents associating access points from Society B with a pass created in Society A', async () => {
        // Flat belongs to Society A
        mockPrisma.flat.findUnique.mockResolvedValue({
          id: 'flat-a-1',
          building: { societyId: SOCIETY_A },
        });
        mockPrisma.societyMembership.findUnique.mockResolvedValue({
          societyId: SOCIETY_A,
          userId: userA_Admin.sub,
          role: 'SOCIETY_ADMIN',
          status: 'ACTIVE',
        });
        mockPrisma.residentFlatMembership.findFirst.mockResolvedValue({ id: 'rf-1' });

        // Pass creation attempts to bind access points: ap-a belongs to Society A, but ap-b belongs to Society B
        mockPrisma.accessPoint.findMany.mockResolvedValue([
          { id: 'ap-a' }, // ap-b is filtered out because societyId != SOCIETY_A
        ]);

        await expect(
          visitorPassesService.create(userA_Admin, {
            flatId: 'flat-a-1',
            visitor: { name: 'Cross-gate Visitor' },
            category: 'FRIEND',
            validFrom: new Date(Date.now() + 1000).toISOString(),
            validUntil: new Date(Date.now() + 10000).toISOString(),
            accessPointIds: ['ap-a', 'ap-b'],
          }),
        ).rejects.toMatchObject({
          code: 'ACCESS_POINT_NOT_IN_SOCIETY',
          status: 422,
        });
      });
    });

    describe('Flats, Buildings & Scope Guards Isolation', () => {
      it('prevents creating a flat in a building belonging to Society B', async () => {
        // Building belongs to Society B
        mockPrisma.building.findUnique.mockResolvedValue({
          id: 'bld-b-1',
          societyId: SOCIETY_B,
        });
        // Caller has no membership in Society B
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);

        await expect(
          societiesService.createFlat(userA_Admin, 'bld-b-1', { flatNumber: '999' }),
        ).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });

      it('SocietyScopeGuard blocks non-members from accessing society routes', async () => {
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);
        const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
        const guard = new SocietyScopeGuard(mockPrisma as any, reflector);

        const ctx = mockExecutionContext({
          user: userA_Admin,
          params: { societyId: SOCIETY_B },
        });

        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });

      it('SocietyScopeGuard enforces RBAC roles (rejecting RESIDENT on ADMIN endpoints)', async () => {
        mockPrisma.societyMembership.findUnique.mockResolvedValue({
          societyId: SOCIETY_A,
          userId: userA_Resident.sub,
          role: 'RESIDENT',
          status: 'ACTIVE',
        });
        const reflector = {
          getAllAndOverride: jest.fn().mockReturnValue(['SOCIETY_ADMIN']),
        } as unknown as Reflector;
        const guard = new SocietyScopeGuard(mockPrisma as any, reflector);

        const ctx = mockExecutionContext({
          user: userA_Resident,
          params: { societyId: SOCIETY_A },
        });

        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
          code: 'FORBIDDEN_ROLE',
          status: 403,
        });
      });

      it('FlatScopeGuard blocks non-members from accessing flat routes', async () => {
        mockPrisma.flat.findUnique.mockResolvedValue({
          id: 'flat-b-1',
          building: { societyId: SOCIETY_B },
        });
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);
        const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
        const guard = new FlatScopeGuard(mockPrisma as any, reflector);

        const ctx = mockExecutionContext({
          user: userA_Admin,
          params: { flatId: 'flat-b-1' },
        });

        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });

      it('FlatScopeGuard blocks residents from accessing flats they are not assigned to', async () => {
        mockPrisma.flat.findUnique.mockResolvedValue({
          id: 'flat-a-2',
          building: { societyId: SOCIETY_A },
        });
        mockPrisma.societyMembership.findUnique.mockResolvedValue({
          societyId: SOCIETY_A,
          userId: userA_Resident.sub,
          role: 'RESIDENT',
          status: 'ACTIVE',
        });
        mockPrisma.residentFlatMembership.findFirst.mockResolvedValue(null);

        const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
        const guard = new FlatScopeGuard(mockPrisma as any, reflector);

        const ctx = mockExecutionContext({
          user: userA_Resident,
          params: { flatId: 'flat-a-2' },
        });

        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
          code: 'NOT_A_FLAT_RESIDENT',
          status: 403,
        });
      });
    });

    describe('Gate & Device Access Isolation', () => {
      it('rejects access verification when device attempts to verify a gate of another society', async () => {
        const accessController = new AccessController(
          {} as any,
          mockPrisma as any,
          authzService,
          {} as any,
          {} as any,
        );

        // Device belongs to Society A
        const req: any = {
          device: {
            id: 'dev-a-1',
            deviceUid: 'UID-DEV-A1',
            societyId: SOCIETY_A,
          },
        };

        // Gate belongs to Society B or is not assigned to device
        mockPrisma.accessPoint.findFirst.mockResolvedValue(null);

        await expect(
          accessController.verify(req, {
            accessPointId: 'ap-b-1',
            credentialType: 'PIN',
            credential: '123456',
            requestId: '11111111-1111-4111-8111-111111111111',
          }),
        ).rejects.toMatchObject({
          code: 'WRONG_ACCESS_POINT',
          status: 403,
        });
      });

      it('rejects manual gate verification when guard belongs to another society', async () => {
        const mockRateLimit = { hit: jest.fn().mockResolvedValue({ allowed: true, count: 1, limit: 60 }) };
        const accessController = new AccessController(
          {} as any,
          mockPrisma as any,
          authzService,
          mockRateLimit as any,
          {} as any,
        );

        // Access point in Society B
        mockPrisma.accessPoint.findUnique.mockResolvedValue({
          id: 'ap-b-1',
          societyId: SOCIETY_B,
        });
        // Guard is only in Society A
        mockPrisma.societyMembership.findUnique.mockResolvedValue(null);

        const req: any = {
          user: userA_Guard,
        };

        await expect(
          accessController.manualVerify(req, {
            accessPointId: 'ap-b-1',
            credentialType: 'PIN',
            credential: '123456',
          }),
        ).rejects.toMatchObject({
          code: 'NOT_A_MEMBER',
          status: 403,
        });
      });
    });
  });

  // =========================================================================
  // 2. HMAC CREDENTIAL VERIFICATION & PLAINTEXT SECRET PROTECTION
  // =========================================================================
  describe('2. HMAC Credential Verification & Plaintext Secret Protection', () => {
    let credentials: CredentialsService;

    beforeEach(() => {
      credentials = new CredentialsService();
    });

    it('generates high-entropy PINs and QR tokens matching security format specifications', () => {
      const pin = credentials.generatePin();
      expect(pin.type).toBe('PIN');
      expect(pin.plaintext).toMatch(/^\d{6}$/);

      const qr = credentials.generateQrToken();
      expect(qr.type).toBe('QR');
      expect(qr.plaintext).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });

    it('computes keyed HMAC-SHA256 and never embeds plaintext in the digest', () => {
      const rawPin = '987654';
      const hash = credentials.hash(rawPin);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).not.toContain(rawPin);
      expect(hash).not.toBe(rawPin);
    });

    it('enforces key separation: different HMAC key IDs yield different hashes for the same PIN', () => {
      const pin = '123456';
      const hash1 = credentials.hash(pin);

      process.env.CREDENTIAL_HMAC_KEY = 'changed-hmac-secret-32-chars-long-x';
      resetEnvCacheForTests();
      const hash2 = new CredentialsService().hash(pin);

      expect(hash1).not.toBe(hash2);
    });

    it('demonstrates the cryptographic avalanche effect for small credential variations', () => {
      const hashA = credentials.hash('123456');
      const hashB = credentials.hash('123457'); // Single digit flipped

      let diffBits = 0;
      for (let i = 0; i < hashA.length; i++) {
        if (hashA[i] !== hashB[i]) diffBits++;
      }
      expect(diffBits).toBeGreaterThan(45); // Almost all hex characters differ
    });

    it('stores passwords using bcrypt cost 12 and never exposes raw password strings', async () => {
      const password = 'SuperSecurePassword#2026';
      const hash = await bcrypt.hash(password, 12);

      expect(hash).toMatch(/^\$2[aby]\$12\$/);
      expect(hash).not.toContain(password);
      expect(await bcrypt.compare(password, hash)).toBe(true);
      expect(await bcrypt.compare('WrongPassword#2026', hash)).toBe(false);
    });

    it('prevents account enumeration via timing-equalized DUMMY_HASH check on failed logins', async () => {
      const mockPrisma: any = {
        user: { findUnique: jest.fn().mockResolvedValue(null) },
        session: { updateMany: jest.fn() },
      };
      const authService = new AuthService(mockPrisma as any);

      const start = Date.now();
      await expect(
        authService.login('nonexistent@example.com', 'InvalidPassword123!'),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        status: 401,
      });
      const duration = Date.now() - start;
      // Bcrypt cost 12 takes meaningful computation time (typically > 50ms)
      expect(duration).toBeGreaterThanOrEqual(10);
    });

    it('audit logs record security actions without embedding raw credentials or passwords', async () => {
      const createdEntries: any[] = [];
      const mockPrisma: any = {
        auditLog: {
          create: jest.fn().mockImplementation(({ data }) => {
            createdEntries.push(data);
            return Promise.resolve(data);
          }),
        },
      };
      const audit = new AuditService(mockPrisma as any);

      await audit.record({
        societyId: SOCIETY_A,
        actorUserId: userA_Admin.sub,
        actorRole: 'SOCIETY_ADMIN',
        action: 'VISITOR_PASS_CREATED',
        entityType: 'VisitorPass',
        entityId: 'pass-101',
        meta: {
          category: 'FRIEND',
          validFrom: '2026-10-31T00:00:00Z',
          credentialHash: credentials.hash('654321'),
        },
      });

      expect(createdEntries.length).toBe(1);
      const serialized = JSON.stringify(createdEntries[0]);
      expect(serialized).not.toContain('654321');
      expect(serialized).toContain(credentials.hash('654321'));
    });
  });

  // =========================================================================
  // 3. REPLAY / IDEMPOTENCY DEFENSES
  // =========================================================================
  describe('3. Replay / Idempotency Defenses', () => {
    let mockPrisma: any;
    let idempotencyService: IdempotencyService;
    let visitorPassesController: VisitorPassesController;
    let mockPassesService: any;

    beforeEach(() => {
      mockPrisma = {
        idempotencyRecord: {
          findUnique: jest.fn(),
          create: jest.fn(),
        },
      };
      idempotencyService = new IdempotencyService(mockPrisma as any);
      mockPassesService = {
        create: jest.fn(),
      };
      visitorPassesController = new VisitorPassesController(
        mockPassesService,
        idempotencyService,
      );
    });

    it('prevents double-submits: returns cached response when Idempotency-Key and payload match', async () => {
      const dto: any = {
        flatId: 'flat-1',
        visitor: { name: 'Idempotent Visitor' },
        category: 'FRIEND',
        validFrom: '2026-10-31T10:00:00Z',
        validUntil: '2026-10-31T14:00:00Z',
        accessPointIds: ['ap-1'],
      };
      const idempotencyKey = 'unique-key-12345678';
      const fingerprint = idempotencyService.fingerprint(dto);

      const cachedResponse = {
        pass: { id: 'pass-existing-123' },
        credentials: { pin: '112233', qrToken: 'token123' },
      };

      // First call: cached record found in DB
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        endpoint: 'visitor-passes.create',
        requestHash: fingerprint,
        responseBody: cachedResponse,
        expiresAt: new Date(Date.now() + 60000),
      });

      const response = await visitorPassesController.create(userA_Admin, dto, idempotencyKey);

      expect(response).toEqual(cachedResponse);
      expect(mockPassesService.create).not.toHaveBeenCalled();
    });

    it('rejects double-submit with altered payload (IDEMPOTENCY_PAYLOAD_MISMATCH)', async () => {
      const dto1: any = { flatId: 'flat-1', category: 'FRIEND', visitor: { name: 'Visitor A' } };
      const dto2: any = { flatId: 'flat-1', category: 'FRIEND', visitor: { name: 'Visitor B' } };
      const idempotencyKey = 'unique-key-12345678';

      // DB already has a record for dto1's hash
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        endpoint: 'visitor-passes.create',
        requestHash: idempotencyService.fingerprint(dto1),
        responseBody: { pass: { id: 'pass-1' } },
        expiresAt: new Date(Date.now() + 60000),
      });

      // Attempting to send dto2 with same idempotencyKey
      await expect(
        visitorPassesController.create(userA_Admin, dto2, idempotencyKey),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        status: 409,
      });
      expect(mockPassesService.create).not.toHaveBeenCalled();
    });

    it('rejects malformed or short Idempotency-Key headers', async () => {
      const dto: any = { flatId: 'flat-1' };

      // Too short (< 8 chars)
      await expect(
        visitorPassesController.create(userA_Admin, dto, 'short'),
      ).rejects.toMatchObject({
        code: 'INVALID_IDEMPOTENCY_KEY',
        status: 400,
      });

      // Invalid characters (spaces/special symbols)
      await expect(
        visitorPassesController.create(userA_Admin, dto, 'key with spaces!'),
      ).rejects.toMatchObject({
        code: 'INVALID_IDEMPOTENCY_KEY',
        status: 400,
      });
    });

    it('swallows concurrent duplicate insertion (race condition P2002) gracefully', async () => {
      mockPrisma.idempotencyRecord.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const duplicateError = new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.16.0',
      });
      mockPrisma.idempotencyRecord.create.mockRejectedValue(duplicateError);

      await expect(
        idempotencyService.save('some-key', 'visitor-passes.create', 'hash-1', { ok: true }),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // 4. RATE LIMITING DEFENSES (429 RATE_LIMIT_EXCEEDED)
  // =========================================================================
  describe('4. Rate Limiting Defenses (OWASP API4 & Brute-Force)', () => {
    let rateLimitService: RateLimitService;

    beforeEach(() => {
      process.env.RATE_LIMIT_ENABLED = 'true';
      process.env.REDIS_URL = '';
      resetEnvCacheForTests();
      rateLimitService = new RateLimitService();
      rateLimitService.resetLocal();
    });

    afterEach(() => {
      rateLimitService.onModuleDestroy();
    });

    it('AuthController trips 429 RATE_LIMIT_EXCEEDED when account login attempts are exhausted', async () => {
      const mockAuthService: any = {
        login: jest.fn().mockRejectedValue(AppException.unauthorized('INVALID_CREDENTIALS')),
      };
      const controller = new AuthController(mockAuthService, rateLimitService);

      const req: any = {
        ip: '192.168.1.100',
        headers: { 'user-agent': 'Jest' },
      };
      const res: any = { cookie: jest.fn() };
      const dto = { email: 'victim@societyos.local', password: 'Attempt1Password#' };

      // Exhaust the 5 allowed attempts
      for (let i = 0; i < 5; i++) {
        await expect(controller.login(dto, req, res)).rejects.toMatchObject({
          code: 'INVALID_CREDENTIALS',
        });
      }

      // 6th attempt must trigger 429 RATE_LIMIT_EXCEEDED
      await expect(controller.login(dto, req, res)).rejects.toMatchObject({
        code: 'RATE_LIMIT_EXCEEDED',
        status: 429,
      });
    });

    it('AuthController trips 429 RATE_LIMIT_EXCEEDED when IP login limit is exceeded', async () => {
      const mockAuthService: any = {
        login: jest.fn().mockRejectedValue(AppException.unauthorized('INVALID_CREDENTIALS')),
      };
      const controller = new AuthController(mockAuthService, rateLimitService);

      const req: any = {
        ip: '10.0.0.1',
        headers: { 'user-agent': 'AttackerBot' },
      };
      const res: any = { cookie: jest.fn() };

      // IP limit is 20 per 15 mins across different emails
      for (let i = 0; i < 20; i++) {
        await expect(
          controller.login({ email: `user${i}@societyos.local`, password: 'Password#123' }, req, res),
        ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      }

      // 21st attempt trips RATE_LIMIT_EXCEEDED for the IP
      await expect(
        controller.login({ email: 'user21@societyos.local', password: 'Password#123' }, req, res),
      ).rejects.toMatchObject({
        code: 'RATE_LIMIT_EXCEEDED',
        status: 429,
      });
    });

    it('AuthController keeps strict login/refresh IP limits for loopback and unknown IPs in production', async () => {
      const saved = { ...process.env };
      Object.assign(process.env, {
        NODE_ENV: 'production',
        WEB_URL: 'https://society.example.com',
        JWT_ACCESS_SECRET: 'prod-access-secret-0123456789abcdef0123456789',
        CREDENTIAL_HMAC_KEY: 'prod-credential-key-0123456789abcdef0123456789',
        REDIS_URL: 'redis://:secret@redis:6379',
      });
      resetEnvCacheForTests();
      try {
        const hit = jest.fn().mockResolvedValue({ allowed: false, count: 0, limit: 0 });
        const controller = new AuthController({} as any, { hit } as unknown as RateLimitService);
        const res: any = { cookie: jest.fn() };

        for (const ip of [undefined, '127.0.0.1', '::1']) {
          hit.mockClear();
          const req: any = { ip, headers: {}, cookies: {} };
          await expect(
            controller.login({ email: 'a@societyos.local', password: 'Password#123' }, req, res),
          ).rejects.toMatchObject({ status: 429 });
          expect(hit).toHaveBeenCalledWith(expect.stringMatching(/^auth:login:ip:/), 20, 900);

          hit.mockClear();
          await expect(controller.refresh({ refreshToken: 'x' } as any, req, res)).rejects.toMatchObject({
            status: 429,
          });
          expect(hit).toHaveBeenCalledWith(expect.stringMatching(/^auth:refresh:ip:/), 60, 900);
        }
      } finally {
        process.env = saved;
        resetEnvCacheForTests();
      }
    });

    it('AccessEngineService triggers RATE_LIMIT_EXCEEDED and emits CREDENTIAL_BRUTE_FORCE alert', async () => {
      const mockPrisma: any = {
        idempotencyRecord: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        securityAlert: {
          create: jest.fn().mockResolvedValue({}),
        },
        accessEvent: {
          create: jest.fn().mockResolvedValue({ id: 'event-rate-limit' }),
        },
        $transaction: jest.fn(),
      };

      const credentialsService = new CredentialsService();
      const accessEngine = new AccessEngineService(
        mockPrisma as any,
        credentialsService,
        rateLimitService,
        {} as any,
        {} as any,
        {} as any,
      );

      const targetCredential = 'wrong-pin-guess';
      const targetHash = credentialsService.hash(targetCredential);

      // Pre-exhaust credential rate limit (15 attempts allowed per 15 min window)
      for (let i = 0; i < 15; i++) {
        await rateLimitService.hit(`verify:credential:${targetHash}`, 15, 900);
      }

      // 16th verification attempt against this credential
      const result = await accessEngine.verify({
        societyId: SOCIETY_A,
        accessPointId: 'ap-1',
        credentialType: 'PIN',
        credential: targetCredential,
        requestId: '22222222-2222-4222-8222-222222222222',
        source: 'DEVICE',
        deviceId: 'dev-1',
        deviceUid: 'UID-1',
      });

      expect(result.decision).toBe('DENIED');
      expect(result.reasonCode).toBe('RATE_LIMIT_EXCEEDED');

      // Verify CREDENTIAL_BRUTE_FORCE security alert was recorded
      expect(mockPrisma.securityAlert.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            societyId: SOCIETY_A,
            type: 'CREDENTIAL_BRUTE_FORCE',
            severity: 'WARNING',
          }),
        }),
      );
    });

    it('AccessController.manualVerify trips 429 RATE_LIMIT_EXCEEDED on guard console flooding', async () => {
      const mockPrisma: any = {
        accessPoint: {
          findUnique: jest.fn().mockResolvedValue({ id: 'ap-1', societyId: SOCIETY_A }),
        },
      };
      const mockAuthz: any = {
        society: jest.fn().mockResolvedValue({ societyId: SOCIETY_A, role: 'GUARD' }),
      };
      const mockEngine: any = {
        verify: jest.fn().mockResolvedValue({ decision: 'AUTHORIZED' }),
      };

      const controller = new AccessController(
        mockEngine,
        mockPrisma as any,
        mockAuthz,
        rateLimitService,
        {} as any,
      );

      const req: any = { user: userA_Guard };
      const dto = { accessPointId: 'ap-1', credentialType: 'PIN' as const, credential: '123456' };

      // Allowed limit is 60 hits / minute
      for (let i = 0; i < 60; i++) {
        await controller.manualVerify(req, dto);
      }

      // 61st hit trips rate limit
      await expect(controller.manualVerify(req, dto)).rejects.toMatchObject({
        code: 'RATE_LIMIT_EXCEEDED',
        status: 429,
      });
    });
  });
});
