process.env.RATE_LIMIT_ENABLED = 'false';
process.env.MQTT_URL = '';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma.service';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';

// Integration tests exercise the HTTP decision engine without broker or rate-limit interference.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://societyos:societyos@localhost:5432/societyos?schema=public';

type Agent = ReturnType<typeof request.agent>;

interface PassResponse {
  pass: { id: string; effectiveStatus: string; requiresApproval: boolean };
  credentials: { pin: string; qrToken: string };
}

const RESIDENT = { email: 'resident.a1@societyos.dev', password: 'Society#2026' };
const GUARD_A = { email: 'guard.a@societyos.dev', password: 'GuardA#2026' };
const GUARD_B = { email: 'guard.b@societyos.dev', password: 'GuardB#2026' };
const RESIDENT_B = { email: 'resident.b1@societyos.dev', password: 'Society#2026' };

const visitorName = `E2E Visitor ${Date.now()}`;

async function login(agent: Agent, credentials: { email: string; password: string }): Promise<void> {
  const response = await agent
    .post('/api/v1/auth/login')
    .send(credentials)
    .expect(200);
  expect(response.body.user).toBeDefined();
  expect(response.body.accessToken).toBeUndefined();
  expect(response.body.refreshToken).toBeUndefined();
  expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly/i);
}

async function flatAndGates(
  agent: Agent,
): Promise<{ flatId: string; societyId: string; gateIds: string[] }> {
  const me = await agent.get('/api/v1/auth/me').expect(200);
  const flatId = me.body.flats[0].id as string;
  const societyId = me.body.flats[0].building.societyId as string;
  const gates = await agent.get(`/api/v1/flats/${flatId}/access-points`).expect(200);
  return { flatId, societyId, gateIds: gates.body.map((gate: { id: string }) => gate.id) };
}

async function createPass(
  agent: Agent,
  input: {
    flatId: string;
    gateId: string;
    category?: 'RELATIVE' | 'FRIEND' | 'DELIVERY';
    maxUses?: number;
  },
): Promise<PassResponse> {
  const now = Date.now();
  const response = await agent
    .post('/api/v1/visitor-passes')
    .set('idempotency-key', `e2e-${now}-${Math.random().toString(36).slice(2, 10)}`)
    .send({
      flatId: input.flatId,
      visitor: { name: visitorName },
      category: input.category ?? 'FRIEND',
      validFrom: new Date(now - 60_000).toISOString(),
      validUntil: new Date(now + 2 * 3600_000).toISOString(),
      maxUses: input.maxUses ?? 1,
      accessPointIds: [input.gateId],
    })
    .expect(201);
  expect(response.body.credentials.pin).toMatch(/^\d{6}$/);
  expect(response.body.credentials.qrToken.length).toBeGreaterThan(20);
  return response.body as PassResponse;
}

async function verify(
  agent: Agent,
  gateId: string,
  credential: string,
): Promise<{ decision: string; reasonCode: string }> {
  const response = await agent
    .post('/api/v1/access/manual-verify')
    .send({ accessPointId: gateId, credentialType: 'PIN', credential })
    .expect(200);
  return response.body as { decision: string; reasonCode: string };
}

describe('SocietyOS access control (integration)', () => {
  let app: INestApplication;
  let residentialAgent: Agent;
  let guardAgent: Agent;
  let flatId: string;
  let societyId: string;
  let gateIds: string[];
  let prisma: PrismaService;
  let originalSettings: unknown;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        stopAtFirstError: true,
        validationError: { target: false, value: false },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    residentialAgent = request.agent(app.getHttpServer());
    guardAgent = request.agent(app.getHttpServer());
    await login(residentialAgent, RESIDENT);
    await login(guardAgent, GUARD_A);
    ({ flatId, societyId, gateIds } = await flatAndGates(residentialAgent));
    expect(gateIds.length).toBeGreaterThanOrEqual(2);

    // A reused local database can already hold this flat's daily pass quota
    // from earlier runs. Raise it for the duration of the suite and restore
    // the seeded policy afterwards so the tests do not require a pristine DB.
    prisma = app.get(PrismaService);
    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: { settings: true },
    });
    originalSettings = society?.settings ?? {};
    const current =
      originalSettings && typeof originalSettings === 'object' && !Array.isArray(originalSettings)
        ? (originalSettings as Record<string, unknown>)
        : {};
    await prisma.society.update({
      where: { id: societyId },
      data: { settings: { ...current, maxPassesPerFlatPerDay: 10000 } },
    });
  });

  afterAll(async () => {
    if (prisma && originalSettings !== undefined) {
      await prisma.society
        .update({ where: { id: societyId }, data: { settings: originalSettings as never } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('reports health and readiness without exposing internals', async () => {
    const health = await request(app.getHttpServer()).get('/api/v1/healthz').expect(200);
    expect(health.body).toMatchObject({ status: 'ok', service: 'societyos-api' });

    const ready = await request(app.getHttpServer()).get('/api/v1/readyz').expect(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.components.database).toBe('ok');
  });

  it('returns a structured error envelope for unauthenticated access', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/visitor-passes')
      .expect(401);
    expect(response.body).toMatchObject({ code: expect.any(String), message: expect.any(String) });
    expect(response.body.requestId).toEqual(expect.any(String));
  });

  it('authorizes a valid pass exactly once and then reports it as used', async () => {
    const created = await createPass(residentialAgent, {
      flatId,
      gateId: gateIds[0],
      maxUses: 1,
    });
    expect(created.pass.effectiveStatus).toBe('ACTIVE');

    await expect(verify(guardAgent, gateIds[0], created.credentials.pin)).resolves.toMatchObject({
      decision: 'AUTHORIZED',
      reasonCode: 'VALID_VISITOR_PASS',
    });
    await expect(verify(guardAgent, gateIds[0], created.credentials.pin)).resolves.toMatchObject({
      decision: 'DENIED',
      reasonCode: 'PASS_ALREADY_USED',
    });
  });

  it('denies a pass presented at a gate it was not issued for', async () => {
    const created = await createPass(residentialAgent, {
      flatId,
      gateId: gateIds[0],
    });
    await expect(verify(guardAgent, gateIds[1], created.credentials.pin)).resolves.toMatchObject({
      decision: 'DENIED',
      reasonCode: 'WRONG_ACCESS_POINT',
    });
  });

  it('requires approval for delivery passes and honors revocation afterwards', async () => {
    const created = await createPass(residentialAgent, {
      flatId,
      gateId: gateIds[0],
      category: 'DELIVERY',
    });
    expect(created.pass.requiresApproval).toBe(true);
    await expect(verify(guardAgent, gateIds[0], created.credentials.pin)).resolves.toMatchObject({
      decision: 'DENIED',
      reasonCode: 'APPROVAL_REQUIRED',
    });

    await residentialAgent
      .post(`/api/v1/visitor-passes/${created.pass.id}/approve`)
      .send({ decision: 'APPROVED' })
      .expect(200);
    await expect(verify(guardAgent, gateIds[0], created.credentials.pin)).resolves.toMatchObject({
      decision: 'AUTHORIZED',
    });

    await residentialAgent
      .post(`/api/v1/visitor-passes/${created.pass.id}/revoke`)
      .send({ reason: 'integration test' })
      .expect(200);
    await expect(verify(guardAgent, gateIds[0], created.credentials.pin)).resolves.toMatchObject({
      decision: 'DENIED',
      reasonCode: 'PASS_REVOKED',
    });
  });

  it('cannot double-spend a single-use pass under concurrent redemption', async () => {
    const created = await createPass(residentialAgent, {
      flatId,
      gateId: gateIds[0],
      maxUses: 1,
    });
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => verify(guardAgent, gateIds[0], created.credentials.pin)),
    );
    expect(attempts.filter((attempt) => attempt.decision === 'AUTHORIZED')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.decision === 'DENIED')).toHaveLength(5);
  });

  it('rejects an unknown credential without revealing whether a pass exists', async () => {
    await expect(verify(guardAgent, gateIds[0], '000001')).resolves.toMatchObject({
      decision: 'DENIED',
      reasonCode: 'INVALID_CREDENTIAL',
    });
  });

  it('blocks cross-society reads and verification', async () => {
    const guardB = request.agent(app.getHttpServer());
    await login(guardB, GUARD_B);
    const forbiddenOverview = await guardB
      .get(`/api/v1/societies/${societyId}/overview`)
      .expect(403);
    expect(forbiddenOverview.body.code).toBe('NOT_A_MEMBER');

    const forbiddenVerify = await guardB
      .post('/api/v1/access/manual-verify')
      .send({ accessPointId: gateIds[0], credentialType: 'PIN', credential: '000001' })
      .expect(403);
    expect(forbiddenVerify.body.code).toBe('NOT_A_MEMBER');

    const residentB = request.agent(app.getHttpServer());
    await login(residentB, RESIDENT_B);
    const otherFlat = await residentB.get('/api/v1/auth/me').expect(200);
    const harbourFlatId = otherFlat.body.flats[0].id as string;
    await residentialAgent.get(`/api/v1/flats/${harbourFlatId}/access-points`).expect(403);
  });
});
