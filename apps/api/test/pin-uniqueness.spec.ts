import * as fs from 'fs';
import * as path from 'path';
import { AccessEngineService } from '../src/access/access-engine.service';
import { CredentialsService } from '../src/visitors/credentials.service';
import { CredentialType } from '@prisma/client';

describe('Per-Society PIN Uniqueness & Global QR Lookup', () => {
  const SOCIETY_A = '11111111-1111-1111-1111-111111111111';
  const SOCIETY_B = '22222222-2222-2222-2222-222222222222';
  const AP_A = '33333333-3333-3333-3333-333333333333';
  const AP_B = '44444444-4444-4444-4444-444444444444';

  let credentialsService: CredentialsService;
  let mockPrisma: any;
  let mockRateLimit: any;
  let mockMqtt: any;
  let mockNotifications: any;
  let mockBiometrics: any;
  let accessEngine: AccessEngineService;

  beforeEach(() => {
    credentialsService = new CredentialsService();
    mockRateLimit = {
      hit: jest.fn().mockResolvedValue({ allowed: true, count: 1 }),
    };
    mockMqtt = {
      publishCommand: jest.fn().mockResolvedValue(undefined),
    };
    mockNotifications = {
      notifyGateArrival: jest.fn().mockResolvedValue(undefined),
    };
    mockBiometrics = {
      verifyResidentBiometric: jest.fn(),
    };
  });

  it('resolves the correct pass when identical PIN is used across two different societies', async () => {
    const pin = '482910';
    const pinHash = credentialsService.hash(pin);

    const passA = {
      id: 'pass-soc-a',
      societyId: SOCIETY_A,
      status: 'ACTIVE',
      validFrom: new Date(Date.now() - 3600_000),
      validUntil: new Date(Date.now() + 3600_000),
      usedCount: 0,
      maxUses: 1,
      visitor: { id: 'vis-a', name: 'Visitor Soc A' },
      accessPoints: [{ accessPointId: AP_A }],
      flat: { flatNumber: '101' },
    };

    const passB = {
      id: 'pass-soc-b',
      societyId: SOCIETY_B,
      status: 'ACTIVE',
      validFrom: new Date(Date.now() - 3600_000),
      validUntil: new Date(Date.now() + 3600_000),
      usedCount: 0,
      maxUses: 1,
      visitor: { id: 'vis-b', name: 'Visitor Soc B' },
      accessPoints: [{ accessPointId: AP_B }],
      flat: { flatNumber: '202' },
    };

    mockPrisma = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(undefined) },
      securityAlert: { create: jest.fn() },
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      accessPoint: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.id === AP_A && where.societyId === SOCIETY_A) {
            return Promise.resolve({ id: AP_A, name: 'Main Gate A' });
          }
          if (where.id === AP_B && where.societyId === SOCIETY_B) {
            return Promise.resolve({ id: AP_B, name: 'Main Gate B' });
          }
          return Promise.resolve(null);
        }),
      },
      visitorPassCredential: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.credentialHash !== pinHash) return Promise.resolve(null);
          // Check society scope for PIN lookup
          const reqSocietyId = where.societyId || where.pass?.societyId || where.OR?.[0]?.societyId || where.OR?.[1]?.pass?.societyId;
          if (reqSocietyId === SOCIETY_A) {
            return Promise.resolve({
              id: 'cred-a',
              type: CredentialType.PIN,
              credentialHash: pinHash,
              societyId: SOCIETY_A,
              pass: passA,
            });
          }
          if (reqSocietyId === SOCIETY_B) {
            return Promise.resolve({
              id: 'cred-b',
              type: CredentialType.PIN,
              credentialHash: pinHash,
              societyId: SOCIETY_B,
              pass: passB,
            });
          }
          return Promise.resolve(null);
        }),
      },
      visitorPass: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      visitorPassUse: {
        create: jest.fn().mockResolvedValue({ id: 'use-1' }),
      },
      accessEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      },
      gateCommand: {
        create: jest.fn().mockResolvedValue({ id: 'cmd-1' }),
      },
    };

    accessEngine = new AccessEngineService(
      mockPrisma,
      credentialsService,
      mockRateLimit,
      mockMqtt,
      mockNotifications,
      mockBiometrics,
    );

    // Verify at Society A
    const resA = await accessEngine.verify({
      societyId: SOCIETY_A,
      accessPointId: AP_A,
      credentialType: 'PIN',
      credential: pin,
      requestId: 'req-a-1',
      source: 'GUARD_CONSOLE',
    });
    expect(resA.decision).toBe('AUTHORIZED');

    // Verify at Society B
    const resB = await accessEngine.verify({
      societyId: SOCIETY_B,
      accessPointId: AP_B,
      credentialType: 'PIN',
      credential: pin,
      requestId: 'req-b-1',
      source: 'GUARD_CONSOLE',
    });
    expect(resB.decision).toBe('AUTHORIZED');

    // Verify findFirst was called with societyId scope
    expect(mockPrisma.visitorPassCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          credentialHash: pinHash,
        }),
      }),
    );
  });

  it('keeps QR tokens globally unique and denies pass presented at wrong society gate', async () => {
    const qrToken = 'global-unique-qr-sample-token-12345';
    const qrHash = credentialsService.hash(qrToken);

    const passA = {
      id: 'pass-soc-a',
      societyId: SOCIETY_A,
      status: 'ACTIVE',
      validFrom: new Date(Date.now() - 3600_000),
      validUntil: new Date(Date.now() + 3600_000),
      usedCount: 0,
      maxUses: 1,
      visitor: { id: 'vis-a', name: 'Visitor Soc A' },
      accessPoints: [{ accessPointId: AP_B }], // allowed at AP_B physically
      flat: { flatNumber: '101' },
    };

    mockPrisma = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(undefined) },
      securityAlert: { create: jest.fn() },
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      accessPoint: {
        findFirst: jest.fn().mockResolvedValue({ id: AP_B, name: 'Gate B' }),
      },
      visitorPassCredential: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cred-qr-1',
          type: CredentialType.QR,
          credentialHash: qrHash,
          pass: passA,
        }),
      },
      accessEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-denied' }),
      },
    };

    accessEngine = new AccessEngineService(
      mockPrisma,
      credentialsService,
      mockRateLimit,
      mockMqtt,
      mockNotifications,
      mockBiometrics,
    );

    // Present Society A's QR at Society B's gate
    const res = await accessEngine.verify({
      societyId: SOCIETY_B,
      accessPointId: AP_B,
      credentialType: 'QR',
      credential: qrToken,
      requestId: 'req-qr-cross',
      source: 'GUARD_CONSOLE',
    });

    expect(res.decision).toBe('DENIED');
    expect(res.reasonCode).toBe('WRONG_SOCIETY');
  });

  it('drops the partial unique index on QR tokens in a new migration', () => {
    const migrationDir = path.resolve(__dirname, '../prisma/migrations');
    const migrations = fs.readdirSync(migrationDir);
    const dropMigration = migrations.find((m) => m.includes('drop_qr_token_unique'));
    expect(dropMigration).toBeDefined();
    const sql = fs.readFileSync(path.join(migrationDir, dropMigration!, 'migration.sql'), 'utf-8');
    expect(sql).toContain('DROP INDEX IF EXISTS "VisitorPassCredential_qr_token_unique";');
  });

  it('explains why QR has no unique constraint in schema.prisma', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf-8');
    expect(schema).toMatch(/QR.*unique.*constraint/i);
    expect(schema).toMatch(/192-bit/i);
  });
});
