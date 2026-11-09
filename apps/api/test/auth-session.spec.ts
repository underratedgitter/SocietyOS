import { ExecutionContext } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuthService } from '../src/auth/auth.service';
import { AuthedRequest, JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { PrismaService } from '../src/common/prisma.service';
import { getEnv, resetEnvCacheForTests } from '../src/config';

const USER_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '66666666-6666-4666-8666-666666666666';

function contextFor(req: Partial<AuthedRequest>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function accessToken(claims: Record<string, unknown>): string {
  const env = getEnv();
  return jwt.sign({ sub: USER_ID, typ: 'access', ...claims }, env.jwtAccessSecret, {
    algorithm: 'HS256',
    expiresIn: 900,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  });
}

describe('JwtAuthGuard session binding', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db';
    resetEnvCacheForTests();
  });

  const user = (overrides: Record<string, unknown> = {}) => ({
    id: USER_ID,
    email: 'resident@example.com',
    name: 'Resident',
    isPlatformAdmin: false,
    mustChangePassword: false,
    memberships: [{ id: 'm-1' }],
    ...overrides,
  });

  function build(session: unknown) {
    const prisma = { session: { findUnique: jest.fn().mockResolvedValue(session) } };
    return { guard: new JwtAuthGuard(prisma as unknown as PrismaService), prisma };
  }

  function request(token: string): Partial<AuthedRequest> {
    return { headers: { authorization: `Bearer ${token}` }, method: 'GET', path: '/api/v1/visitor-passes' };
  }

  const live = () => ({ userId: USER_ID, revokedAt: null, expiresAt: new Date(Date.now() + 60_000), user: user() });

  it('accepts a token whose session is live and loads the user through it', async () => {
    const { guard, prisma } = build(live());
    const req = request(accessToken({ sid: SESSION_ID }));

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(prisma.session.findUnique.mock.calls[0][0].where).toEqual({ id: SESSION_ID });
    expect(req.user?.sub).toBe(USER_ID);
  });

  it('rejects an access token after its session was revoked (e.g. by a password change)', async () => {
    const { guard } = build({ ...live(), revokedAt: new Date() });
    await expect(guard.canActivate(contextFor(request(accessToken({ sid: SESSION_ID }))))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
  });

  it('rejects an expired session, a session of another user and a token without sid', async () => {
    const expired = build({ ...live(), expiresAt: new Date(Date.now() - 1) });
    await expect(expired.guard.canActivate(contextFor(request(accessToken({ sid: SESSION_ID }))))).rejects.toMatchObject({ status: 401 });

    const foreign = build({ ...live(), userId: '77777777-7777-4777-8777-777777777777' });
    await expect(foreign.guard.canActivate(contextFor(request(accessToken({ sid: SESSION_ID }))))).rejects.toMatchObject({ status: 401 });

    const legacy = build(live());
    await expect(legacy.guard.canActivate(contextFor(request(accessToken({}))))).rejects.toMatchObject({ status: 401 });
    await expect(legacy.guard.canActivate(contextFor(request(accessToken({ sid: 'not-a-uuid' }))))).rejects.toMatchObject({ status: 401 });
    expect(legacy.prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a user without any active membership unless they are a platform admin', async () => {
    const disabled = build({ ...live(), user: user({ memberships: [] }) });
    await expect(disabled.guard.canActivate(contextFor(request(accessToken({ sid: SESSION_ID }))))).rejects.toMatchObject({
      code: 'ACCOUNT_DISABLED',
      status: 403,
    });

    const admin = build({ ...live(), user: user({ memberships: [], isPlatformAdmin: true }) });
    await expect(admin.guard.canActivate(contextFor(request(accessToken({ sid: SESSION_ID }))))).resolves.toBe(true);
  });
});

describe('AuthService session-bound tokens', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db';
    resetEnvCacheForTests();
  });

  const userRow = {
    id: USER_ID,
    email: 'resident@example.com',
    name: 'Resident',
    phone: null,
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  function build(activeMemberships: { id: string }[]) {
    const calls: string[] = [];
    const tx = {
      session: {
        updateMany: jest.fn(async () => {
          calls.push('revoke');
          return { count: 1 };
        }),
        create: jest.fn(async () => {
          calls.push('issue');
          return { id: SESSION_ID };
        }),
      },
      $queryRaw: jest.fn(async () => {
        calls.push('membership-check');
        return activeMemberships;
      }),
    };
    const prisma = {
      session: {
        findUnique: jest.fn().mockResolvedValue({
          id: '88888888-8888-4888-8888-888888888888',
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          userAgent: null,
          user: userRow,
        }),
      },
      societyMembership: { count: jest.fn() },
      $transaction: jest.fn(async (cb: (client: unknown) => Promise<unknown>) => cb(tx)),
    };
    return { service: new AuthService(prisma as unknown as PrismaService), prisma, tx, calls };
  }

  it('issues an access token carrying the new session id', async () => {
    const { service } = build([{ id: 'm-1' }]);
    const result = await service.refresh('refresh-token');
    const decoded = jwt.decode(result.accessToken) as jwt.JwtPayload;
    expect(decoded.sid).toBe(SESSION_ID);
  });

  it('checks active memberships FOR SHARE inside the rotation transaction', async () => {
    const { service, prisma, tx, calls } = build([{ id: 'm-1' }]);
    await service.refresh('refresh-token');

    expect(calls).toEqual(['revoke', 'membership-check', 'issue']);
    const [sql, userId] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(sql.join('?')).toMatch(/"status" = 'ACTIVE'\s+FOR SHARE/);
    expect(userId).toBe(USER_ID);
    expect(prisma.societyMembership.count).not.toHaveBeenCalled();
  });

  it('refuses to rotate when no membership is active at rotation time', async () => {
    const { service, calls } = build([]);
    await expect(service.refresh('refresh-token')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED', status: 403 });
    expect(calls).toEqual(['revoke', 'membership-check']);
  });
});
