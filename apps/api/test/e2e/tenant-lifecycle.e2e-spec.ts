process.env.RATE_LIMIT_ENABLED = 'false';
process.env.MQTT_URL = '';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  Agent,
  USERS,
  createTestApp,
  login,
  testSlug,
  uniqueSuffix,
} from './support';

const ADMIN_PASSWORD = 'TenantAdmin#2026';
const RESIDENT_PASSWORD = 'TenantResident#2026';
const GUARD_PASSWORD = 'TenantGuard#2026';

describe('Tenant onboarding and authorization (integration)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let platform: Agent;
  let admin: Agent;
  let resident: Agent;
  let guard: Agent;

  let societyId: string;
  let societySlug: string;
  let adminEmail: string;
  let adminTemporaryPassword: string;
  let residentEmail: string;
  let residentTemporaryPassword: string;
  let guardEmail: string;
  let guardTemporaryPassword: string;
  let buildingId: string;
  let flatId: string;
  let accessPointId: string;
  let passId: string;
  let passPin: string;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    platform = request.agent(server);
    await login(platform, USERS.platform);
    societySlug = testSlug('tenant-e2e');
    adminEmail = `admin-${uniqueSuffix()}@example.com`;
    residentEmail = `resident-${uniqueSuffix()}@example.com`;
    guardEmail = `guard-${uniqueSuffix()}@example.com`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('onboards a society and returns the administrator password exactly once', async () => {
    const response = await platform
      .post('/api/v1/societies')
      .send({
        name: 'Tenant E2E Residency',
        slug: societySlug,
        timezone: 'Asia/Kolkata',
        adminName: 'Tenant Administrator',
        adminEmail,
      })
      .expect(201);

    societyId = response.body.society.id;
    adminTemporaryPassword = response.body.admin.temporaryPassword;
    expect(societyId).toEqual(expect.any(String));
    expect(response.body.society.slug).toBe(societySlug);
    expect(adminTemporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(response.body.admin).toMatchObject({ email: adminEmail });

    const duplicate = await platform
      .post('/api/v1/societies')
      .send({
        name: 'Duplicate',
        slug: societySlug,
        adminName: 'Someone Else',
        adminEmail: `other-${uniqueSuffix()}@example.com`,
      })
      .expect(409);
    expect(duplicate.body.code).toBe('SLUG_TAKEN');

    const invalidTimezone = await platform
      .post('/api/v1/societies')
      .send({
        name: 'Invalid Timezone',
        slug: testSlug('tz-e2e'),
        timezone: 'Mars/Olympus',
        adminName: 'Someone Else',
        adminEmail: `tz-${uniqueSuffix()}@example.com`,
      })
      .expect(422);
    expect(invalidTimezone.body.code).toBe('INVALID_TIMEZONE');
  });

  it('forces a temporary administrator to rotate the password before tenant access', async () => {
    admin = request.agent(server);
    const loggedIn = await login(admin, { email: adminEmail, password: adminTemporaryPassword });
    expect(loggedIn.body.user.mustChangePassword).toBe(true);

    await admin.get('/api/v1/auth/me').expect(200);
    const blocked = await admin.get(`/api/v1/societies/${societyId}/overview`).expect(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await admin
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: adminTemporaryPassword, newPassword: ADMIN_PASSWORD })
      .expect(200);
    expect(changed.body.user.mustChangePassword).toBe(false);

    await login(request.agent(server), { email: adminEmail, password: adminTemporaryPassword }, 401);
    const reloaded = await login(request.agent(server), { email: adminEmail, password: ADMIN_PASSWORD });
    expect(reloaded.body.user.mustChangePassword).toBe(false);

    const overview = await admin.get(`/api/v1/societies/${societyId}/overview`).expect(200);
    expect(overview.body.role).toBe('SOCIETY_ADMIN');
    expect(overview.body.counts.buildings).toBe(0);
  });

  it('builds the society structure, invites residents and creates staff', async () => {
    const building = await admin
      .post(`/api/v1/societies/${societyId}/buildings`)
      .send({ name: 'Tenant Block' })
      .expect(201);
    buildingId = building.body.id;

    const flat = await admin
      .post(`/api/v1/buildings/${buildingId}/flats`)
      .send({ flatNumber: 'T-101' })
      .expect(201);
    flatId = flat.body.id;

    const duplicateFlat = await admin
      .post(`/api/v1/buildings/${buildingId}/flats`)
      .send({ flatNumber: 'T-101' })
      .expect(409);
    expect(duplicateFlat.body.code).toBe('FLAT_EXISTS');

    const invited = await admin
      .post(`/api/v1/societies/${societyId}/residents`)
      .send({
        name: 'Tenant Resident',
        email: residentEmail,
        flatId,
        relationship: 'TENANT',
      })
      .expect(201);
    residentTemporaryPassword = invited.body.temporaryPassword;
    expect(residentTemporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const createdGuard = await admin
      .post(`/api/v1/societies/${societyId}/guards`)
      .send({ name: 'Tenant Guard', email: guardEmail })
      .expect(201);
    guardTemporaryPassword = createdGuard.body.temporaryPassword;
    expect(guardTemporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const accessPoint = await admin
      .post(`/api/v1/societies/${societyId}/access-points`)
      .send({ name: 'Tenant Main Gate', type: 'SLIDING_GATE' })
      .expect(201);
    accessPointId = accessPoint.body.id;

    const policy = await admin
      .patch(`/api/v1/societies/${societyId}`)
      .send({ policy: { approvalCategories: ['DELIVERY'], maxPassesPerFlatPerDay: 7 } })
      .expect(200);
    expect(policy.body.policy).toMatchObject({
      approvalCategories: ['DELIVERY'],
      maxPassesPerFlatPerDay: 7,
      maxUsesPerPass: 5,
      maxPassDurationHours: 24,
    });

    const invalidTimezone = await admin
      .patch(`/api/v1/societies/${societyId}`)
      .send({ timezone: 'Not/AZone' })
      .expect(422);
    expect(invalidTimezone.body.code).toBe('INVALID_TIMEZONE');

    const flats = await admin.get(`/api/v1/societies/${societyId}/flats`).expect(200);
    expect(flats.body).toHaveLength(1);
    expect(flats.body[0].residents[0].email).toBe(residentEmail);
  });

  it('scopes the resident to their flat and blocks staff-only views', async () => {
    resident = request.agent(server);
    await login(resident, { email: residentEmail, password: residentTemporaryPassword });
    await resident
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: residentTemporaryPassword, newPassword: RESIDENT_PASSWORD })
      .expect(200);

    const me = await resident.get('/api/v1/auth/me').expect(200);
    expect(me.body.flats).toHaveLength(1);
    expect(me.body.flats[0].id).toBe(flatId);

    const flats = await resident.get(`/api/v1/societies/${societyId}/flats`).expect(200);
    expect(flats.body).toHaveLength(1);
    expect(flats.body[0].id).toBe(flatId);
    expect(flats.body[0].residents[0].email).toBeUndefined();

    await resident.get(`/api/v1/societies/${societyId}/residents`).expect(403);
    await resident.get(`/api/v1/societies/${societyId}/audit-logs`).expect(403);
    await resident
      .get(`/api/v1/societies/${societyId}/security-alerts`)
      .expect(403);

    const ownPass = await resident
      .post('/api/v1/visitor-passes')
      .set('idempotency-key', `tenant-${uniqueSuffix()}`)
      .send({
        flatId,
        visitor: { name: 'Tenant Guest' },
        category: 'FRIEND',
        validFrom: new Date(Date.now() - 60_000).toISOString(),
        validUntil: new Date(Date.now() + 2 * 3600_000).toISOString(),
        maxUses: 1,
        accessPointIds: [accessPointId],
      })
      .expect(201);
    passId = ownPass.body.pass.id;
    passPin = ownPass.body.credentials.pin;

    const otherFlat = await resident
      .post('/api/v1/visitor-passes')
      .set('idempotency-key', `tenant-${uniqueSuffix()}`)
      .send({
        flatId: '00000000-0000-4000-8000-000000000000',
        visitor: { name: 'Wrong Flat Guest' },
        category: 'FRIEND',
        validFrom: new Date(Date.now() - 60_000).toISOString(),
        validUntil: new Date(Date.now() + 3600_000).toISOString(),
        maxUses: 1,
        accessPointIds: [accessPointId],
      })
      .expect(404);
    expect(otherFlat.body.code).toBe('FLAT_NOT_FOUND');
  });

  it('lets an invited guard verify entry but not read audit logs', async () => {
    guard = request.agent(server);
    await login(guard, { email: guardEmail, password: guardTemporaryPassword });
    await guard
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: guardTemporaryPassword, newPassword: GUARD_PASSWORD })
      .expect(200);

    const verified = await guard
      .post('/api/v1/access/manual-verify')
      .send({ accessPointId, credentialType: 'PIN', credential: passPin })
      .expect(200);
    expect(verified.body).toMatchObject({
      decision: 'AUTHORIZED',
      reasonCode: 'VALID_VISITOR_PASS',
    });

    const used = await guard
      .post('/api/v1/access/manual-verify')
      .send({ accessPointId, credentialType: 'PIN', credential: passPin })
      .expect(200);
    expect(used.body).toMatchObject({ decision: 'DENIED', reasonCode: 'PASS_ALREADY_USED' });

    await guard.get(`/api/v1/societies/${societyId}/audit-logs`).expect(403);
    const overview = await guard.get(`/api/v1/societies/${societyId}/overview`).expect(200);
    expect(overview.body.role).toBe('GUARD');
  });

  it('records the onboarding and access actions in the audit trail', async () => {
    const logs = await admin.get(`/api/v1/societies/${societyId}/audit-logs`).expect(200);
    const actions = (logs.body as { action: string }[]).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'SOCIETY_CREATED',
        'BUILDING_CREATED',
        'FLAT_CREATED',
        'RESIDENT_LINKED',
        'GUARD_CREATED',
        'ACCESS_POINT_CREATED',
        'VISITOR_PASS_CREATED',
      ]),
    );

    const pass = await resident.get(`/api/v1/visitor-passes/${passId}`).expect(200);
    expect(pass.body).toMatchObject({
      id: passId,
      effectiveStatus: 'EXHAUSTED',
      usedCount: 1,
      maxUses: 1,
    });
  });

  it('blocks another tenant from reading or acting on this society', async () => {
    const outsideAdmin = request.agent(server);
    await login(outsideAdmin, USERS.adminB);

    const overview = await outsideAdmin
      .get(`/api/v1/societies/${societyId}/overview`)
      .expect(403);
    expect(overview.body.code).toBe('NOT_A_MEMBER');

    const building = await outsideAdmin
      .post(`/api/v1/societies/${societyId}/buildings`)
      .send({ name: 'Intruder Block' })
      .expect(403);
    expect(building.body.code).toBe('NOT_A_MEMBER');

    const residentB = request.agent(server);
    await login(residentB, USERS.residentB);
    await residentB.get(`/api/v1/flats/${flatId}/household`).expect(403);
    await residentB
      .post('/api/v1/visitor-passes')
      .set('idempotency-key', `tenant-${uniqueSuffix()}`)
      .send({
        flatId,
        visitor: { name: 'Cross Tenant Guest' },
        category: 'FRIEND',
        validFrom: new Date(Date.now() - 60_000).toISOString(),
        validUntil: new Date(Date.now() + 3600_000).toISOString(),
        maxUses: 1,
        accessPointIds: [accessPointId],
      })
      .expect(403);
  });

  it('lists the new society for the platform operator', async () => {
    const societies = await platform.get('/api/v1/societies').expect(200);
    const created = (societies.body as { id: string; role: string }[]).find(
      (entry) => entry.id === societyId,
    );
    expect(created).toBeDefined();
    expect(created!.role).toBe('PLATFORM_ADMIN');
  });
});
