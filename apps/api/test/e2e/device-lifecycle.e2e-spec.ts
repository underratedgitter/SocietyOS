process.env.RATE_LIMIT_ENABLED = 'false';
process.env.MQTT_URL = '';

import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import {
  Agent,
  USERS,
  createAccessPoint,
  createPass,
  createTestApp,
  createTestFlat,
  login,
  provisionDevice,
} from './support';

describe('Device lifecycle and controller-outage handling (integration)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let admin: Agent;
  let resident: Agent;

  let societyId: string;
  let flatId: string;
  let accessPointId: string;
  let unassignedAccessPointId: string;
  let deviceId: string;
  let deviceToken: string;
  let passId: string;
  let passPin: string;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    admin = request.agent(server);
    await login(admin, USERS.adminA);
    const societies = await admin.get('/api/v1/societies').expect(200);
    const society = (societies.body as { id: string; role: string }[]).find(
      (entry) => entry.role === 'SOCIETY_ADMIN',
    );
    expect(society).toBeDefined();
    societyId = society!.id;

    const flat = await createTestFlat(admin, societyId, USERS.residentA.email, 'Meera Iyer');
    flatId = flat.flatId;

    const accessPoint = await createAccessPoint(admin, societyId, 'E2E Device Gate');
    accessPointId = accessPoint.id;
    const unassigned = await createAccessPoint(admin, societyId, 'E2E Unassigned Gate');
    unassignedAccessPointId = unassigned.id;

    const provisioned = await provisionDevice(admin, societyId, accessPointId);
    deviceId = provisioned.device.id;
    deviceToken = provisioned.credentials.deviceToken;
    expect(deviceToken).toMatch(/^sos_dev_/);

    resident = request.agent(server);
    await login(resident, USERS.residentA);
    const pass = await createPass(resident, {
      flatId,
      accessPointId,
      name: 'Controller Outage Visitor',
    });
    passId = pass.pass.id;
    passPin = pass.credentials.pin;
  });

  afterAll(async () => {
    if (prisma && deviceId) {
      await prisma.idempotencyRecord
        .deleteMany({ where: { key: { startsWith: `access-verify:${deviceId}:` } } })
        .catch(() => undefined);
      await prisma.accessEvent
        .deleteMany({ where: { OR: [{ deviceId }, { passId }] } })
        .catch(() => undefined);
      await prisma.gateCommand.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceHealthLog.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceEvent.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceCredential.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceAccessPoint.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.device.deleteMany({ where: { id: deviceId } }).catch(() => undefined);
    }
    if (prisma && passId) {
      await prisma.visitorPassUse.deleteMany({ where: { passId } }).catch(() => undefined);
      await prisma.visitorApproval.deleteMany({ where: { passId } }).catch(() => undefined);
      await prisma.visitorPassCredential.deleteMany({ where: { passId } }).catch(() => undefined);
      await prisma.visitorPassAccessPoint.deleteMany({ where: { passId } }).catch(() => undefined);
      const pass = await prisma.visitorPass.findUnique({ where: { id: passId } }).catch(() => null);
      await prisma.visitorPass.deleteMany({ where: { id: passId } }).catch(() => undefined);
      if (pass) {
        await prisma.visitor.deleteMany({ where: { id: pass.visitorId } }).catch(() => undefined);
      }
    }
    if (prisma && flatId) {
      await prisma.residentFlatMembership.deleteMany({ where: { flatId } }).catch(() => undefined);
      await prisma.flat.deleteMany({ where: { id: flatId } }).catch(() => undefined);
    }
    if (prisma && accessPointId) {
      await prisma.visitorPassAccessPoint
        .deleteMany({ where: { accessPointId } })
        .catch(() => undefined);
      await prisma.gateCommand.deleteMany({ where: { accessPointId } }).catch(() => undefined);
      await prisma.deviceAccessPoint.deleteMany({ where: { accessPointId } }).catch(() => undefined);
      await prisma.accessEvent
        .deleteMany({ where: { accessPointId } })
        .catch(() => undefined);
      await prisma.accessPoint.deleteMany({ where: { id: accessPointId } }).catch(() => undefined);
    }
    if (prisma && unassignedAccessPointId) {
      await prisma.accessPoint
        .deleteMany({ where: { id: unassignedAccessPointId } })
        .catch(() => undefined);
    }
    await app.close();
  });

  function deviceCall(method: 'get' | 'post', path: string, token = deviceToken) {
    return request(server)
      [method](path)
      .set('Authorization', `Bearer ${token}`);
  }

  it('authenticates the provisioned device and exposes only its own gates', async () => {
    const me = await deviceCall('get', '/api/v1/device-api/me').expect(200);
    expect(me.body).toMatchObject({
      id: deviceId,
      deviceUid: expect.stringMatching(/^e2e-/),
      societyId,
      status: 'ACTIVE',
    });
    expect(me.body.accessPoints.map((link: { accessPoint: { id: string } }) => link.accessPoint.id)).toEqual([
      accessPointId,
    ]);

    await deviceCall('get', '/api/v1/device-api/me', 'not-a-valid-device-token').expect(401);
  });

  it('accepts signed-in health and event telemetry for assigned gates', async () => {
    const health = await deviceCall('post', '/api/v1/device-api/health')
      .send({ online: true, uptimeS: 19, rssi: -57, meta: { firmware: 'e2e' } })
      .expect(201);
    expect(health.body.ok).toBe(true);

    const event = await deviceCall('post', '/api/v1/device-api/events')
      .send({
        type: 'HEARTBEAT',
        accessPointId,
        sequence: 7,
        payload: { state: 'CLOSED' },
      })
      .expect(201);
    expect(event.body.eventId).toEqual(expect.any(String));

    const logs = await admin.get(`/api/v1/devices/${deviceId}/health`).expect(200);
    expect(logs.body.healthLogs).toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId, uptimeS: 19, rssi: -57 })]),
    );

    const unassigned = await deviceCall('post', '/api/v1/device-api/events')
      .send({ type: 'SENSOR', accessPointId: unassignedAccessPointId, payload: { state: 'OPEN' } })
      .expect(403);
    expect(unassigned.body.code).toBe('WRONG_ACCESS_POINT');

    const oversized = await deviceCall('post', '/api/v1/device-api/health')
      .send({ online: true, meta: { note: 'x'.repeat(5_000) } })
      .expect(422);
    expect(oversized.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('denies a live pass when the controller cannot be reached and does not burn a use', async () => {
    const requestId = randomUUID();
    const response = await deviceCall('post', '/api/v1/access/verify')
      .send({ accessPointId, credentialType: 'PIN', credential: passPin, requestId })
      .expect(200);
    expect(response.body).toMatchObject({
      decision: 'DENIED',
      reasonCode: 'CONTROLLER_UNAVAILABLE',
    });

    const pass = await resident.get(`/api/v1/visitor-passes/${passId}`).expect(200);
    expect(pass.body).toMatchObject({
      usedCount: 0,
      effectiveStatus: 'ACTIVE',
    });

    const command = await prisma.gateCommand.findFirst({
      where: { deviceId },
      orderBy: { issuedAt: 'desc' },
    });
    expect(command).toMatchObject({ status: 'EXPIRED', signedPayload: null });

    const events = await prisma.accessEvent.findMany({ where: { requestId } });
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.decision === 'AUTHORIZED')).toHaveLength(1);
    expect(
      events.find((event) => event.decision === 'DENIED')?.reasonCode,
    ).toBe('CONTROLLER_UNAVAILABLE');
  });

  it('makes device verification idempotent and rejects a reused key with new content', async () => {
    const requestId = randomUUID();
    const first = await deviceCall('post', '/api/v1/access/verify')
      .send({ accessPointId, credentialType: 'PIN', credential: passPin, requestId })
      .expect(200);
    const replay = await deviceCall('post', '/api/v1/access/verify')
      .send({ accessPointId, credentialType: 'PIN', credential: passPin, requestId })
      .expect(200);
    expect(replay.body).toEqual(first.body);

    const mismatch = await deviceCall('post', '/api/v1/access/verify')
      .send({ accessPointId, credentialType: 'PIN', credential: '000002', requestId })
      .expect(409);
    expect(mismatch.body.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('rejects a pass presented at an unassigned gate before consuming it', async () => {
    const response = await deviceCall('post', '/api/v1/access/verify')
      .send({
        accessPointId: unassignedAccessPointId,
        credentialType: 'PIN',
        credential: passPin,
        requestId: randomUUID(),
      })
      .expect(403);
    expect(response.body.code).toBe('WRONG_ACCESS_POINT');

    const pass = await resident.get(`/api/v1/visitor-passes/${passId}`).expect(200);
    expect(pass.body.usedCount).toBe(0);
  });

  it('rotates credentials immediately, then disables and re-enables the device', async () => {
    const rotated = await admin
      .post(`/api/v1/devices/${deviceId}/rotate-credential`)
      .expect(201);
    const newToken = rotated.body.credentials.deviceToken as string;
    expect(newToken).toEqual(expect.any(String));
    expect(newToken).not.toBe(deviceToken);

    await deviceCall('get', '/api/v1/device-api/me', deviceToken).expect(401);
    await deviceCall('get', '/api/v1/device-api/me', newToken).expect(200);
    deviceToken = newToken;

    await admin.post(`/api/v1/devices/${deviceId}/disable`).expect(201);
    const disabled = await deviceCall('get', '/api/v1/device-api/me').expect(401);
    expect(disabled.body.code).toBe('DEVICE_DISABLED');

    await admin.post(`/api/v1/devices/${deviceId}/enable`).expect(201);
    await deviceCall('get', '/api/v1/device-api/me').expect(200);
  });

  it('does not expose device control or health to residents', async () => {
    await resident.get(`/api/v1/devices/${deviceId}/health`).expect(403);
    await resident.post(`/api/v1/devices/${deviceId}/disable`).expect(403);
    await resident.post(`/api/v1/devices/${deviceId}/rotate-credential`).expect(403);
  });
});
