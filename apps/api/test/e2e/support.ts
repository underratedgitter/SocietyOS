import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';

export type Agent = ReturnType<typeof request.agent>;

export const USERS = {
  platform: { email: 'platform@societyos.dev', password: 'Platform#2026' },
  adminA: { email: 'admin.a@societyos.dev', password: 'AdminA#2026' },
  adminB: { email: 'admin.b@societyos.dev', password: 'AdminB#2026' },
  guardA: { email: 'guard.a@societyos.dev', password: 'GuardA#2026' },
  guardB: { email: 'guard.b@societyos.dev', password: 'GuardB#2026' },
  residentA: { email: 'resident.a1@societyos.dev', password: 'Society#2026' },
  residentB: { email: 'resident.b1@societyos.dev', password: 'Society#2026' },
} as const;

export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication();
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
  return app;
}

export function login(
  agent: Agent,
  credentials: { email: string; password: string },
  expectedStatus = 200,
) {
  return agent.post('/api/v1/auth/login').send(credentials).expect(expectedStatus);
}

export function setCookies(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function cookieValue(response: request.Response, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const cookie of setCookies(response)) {
    const pair = cookie.split(';')[0];
    if (pair.startsWith(prefix)) return decodeURIComponent(pair.slice(prefix.length));
  }
  return undefined;
}

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function testSlug(prefix = 'e2e-society'): string {
  return `${prefix}-${uniqueSuffix()}`.toLowerCase().slice(0, 60);
}

export async function waitFor<T>(
  probe: () => Promise<T | false | null | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${options.label ?? 'condition'}${
      lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''
    }`,
  );
}

export interface TestFlat {
  buildingId: string;
  flatId: string;
  flatNumber: string;
}

/**
 * Creates a fresh flat for a suite and links an existing resident to it. A new
 * flat per run keeps the suite independent of the seeded per-flat daily pass
 * quota and of data left behind by earlier runs.
 */
export async function createTestFlat(
  admin: Agent,
  societyId: string,
  residentEmail: string,
  residentName: string,
): Promise<TestFlat> {
  const buildingsResponse = await admin
    .get(`/api/v1/societies/${societyId}/buildings`)
    .expect(200);
  let building = (buildingsResponse.body as { id: string; name: string }[]).find(
    (entry) => entry.name === 'Automation Wing',
  );
  if (!building) {
    const created = await admin
      .post(`/api/v1/societies/${societyId}/buildings`)
      .send({ name: 'Automation Wing' })
      .expect(201);
    building = created.body as { id: string; name: string };
  }

  const flatNumber = `E2E-${uniqueSuffix()}`.slice(0, 20);
  const flatResponse = await admin
    .post(`/api/v1/buildings/${building.id}/flats`)
    .send({ flatNumber })
    .expect(201);
  const flatId = (flatResponse.body as { id: string }).id;

  await admin
    .post(`/api/v1/flats/${flatId}/members`)
    .send({ name: residentName, email: residentEmail, relationship: 'FAMILY' })
    .expect(201);

  return { buildingId: building.id, flatId, flatNumber };
}

export async function createAccessPoint(
  admin: Agent,
  societyId: string,
  name = 'E2E Vehicle Gate',
): Promise<{ id: string; name: string }> {
  const response = await admin
    .post(`/api/v1/societies/${societyId}/access-points`)
    .send({ name, type: 'BOOM_BARRIER', location: 'E2E test lane' })
    .expect(201);
  return response.body as { id: string; name: string };
}

export interface ProvisionedDevice {
  device: { id: string; deviceUid: string; name: string; societyId: string };
  credentials: { deviceToken: string; commandSecret: string };
  deviceUid: string;
}

export async function provisionDevice(
  admin: Agent,
  societyId: string,
  accessPointId: string,
  name = 'E2E Barrier Controller',
): Promise<ProvisionedDevice> {
  const deviceUid = `e2e-${uniqueSuffix()}`.slice(0, 80);
  const response = await admin
    .post(`/api/v1/societies/${societyId}/devices`)
    .send({
      name,
      deviceUid,
      firmware: 'e2e-1.0.0',
      accessPointIds: [accessPointId],
    })
    .expect(201);
  const body = response.body as {
    device: { id: string; deviceUid: string; name: string; societyId: string };
    credentials: { deviceToken: string; commandSecret: string };
  };
  return { ...body, deviceUid };
}

export interface CreatedPass {
  pass: {
    id: string;
    status: string;
    effectiveStatus: string;
    requiresApproval: boolean;
    usedCount?: number;
  };
  credentials: { pin: string; qrToken: string };
  idempotencyKey: string;
}

export async function createPass(
  agent: Agent,
  input: {
    flatId: string;
    accessPointId: string;
    category?: 'RELATIVE' | 'FRIEND' | 'DELIVERY' | 'CAB' | 'MAINTENANCE' | 'OTHER';
    maxUses?: number;
    name?: string;
  },
): Promise<CreatedPass> {
  const now = Date.now();
  const idempotencyKey = `e2e-${uniqueSuffix()}`;
  const response = await agent
    .post('/api/v1/visitor-passes')
    .set('idempotency-key', idempotencyKey)
    .send({
      flatId: input.flatId,
      visitor: { name: input.name ?? `E2E Visitor ${uniqueSuffix()}` },
      category: input.category ?? 'FRIEND',
      validFrom: new Date(now - 60_000).toISOString(),
      validUntil: new Date(now + 2 * 3600_000).toISOString(),
      maxUses: input.maxUses ?? 1,
      accessPointIds: [input.accessPointId],
    })
    .expect(201);
  return { ...(response.body as Omit<CreatedPass, 'idempotencyKey'>), idempotencyKey };
}
