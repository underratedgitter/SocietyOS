process.env.RATE_LIMIT_ENABLED = 'false';

// The protocol suite needs a real broker so it can verify the exact wire
// contract (QoS 1 topic, HMAC signature, nonce and signed acknowledgement).
// CI provides one; local runs opt in with MQTT_TEST_URL.
const BROKER_URL = process.env.MQTT_TEST_URL?.trim() || '';
process.env.MQTT_URL = BROKER_URL;

import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import mqtt from 'mqtt';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { commandTopic, MqttService } from '../../src/devices/mqtt.service';
import {
  AckSignature,
  SignableCommand,
  signAck,
  verifyCommand,
} from '../../src/common/crypto.util';
import {
  Agent,
  USERS,
  createAccessPoint,
  createPass,
  createTestApp,
  createTestFlat,
  login,
  provisionDevice,
  uniqueSuffix,
  waitFor,
} from './support';

interface SignedCommand extends SignableCommand {
  signature: string;
}

const describeWithBroker = BROKER_URL ? describe : describe.skip;

describeWithBroker('MQTT signed command protocol (integration)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let mqttService: MqttService;
  let admin: Agent;
  let resident: Agent;
  let client: mqtt.MqttClient;

  let societyId: string;
  let flatId: string;
  let accessPointId: string;
  let deviceId: string;
  let deviceToken: string;
  let commandSecret: string;
  let commandTopicName: string;
  let acknowledgementTopic: string;
  const passIds: string[] = [];
  const visitorNames: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    mqttService = app.get(MqttService);

    await waitFor(() => Promise.resolve(mqttService.connected), {
      timeoutMs: 10_000,
      label: `API connection to ${BROKER_URL}`,
    });

    admin = request.agent(server);
    await login(admin, USERS.adminA);
    const societies = await admin.get('/api/v1/societies').expect(200);
    const society = (societies.body as { id: string; role: string }[]).find(
      (entry) => entry.role === 'SOCIETY_ADMIN',
    );
    societyId = society!.id;

    const flat = await createTestFlat(admin, societyId, USERS.residentA.email, 'Meera Iyer');
    flatId = flat.flatId;
    const accessPoint = await createAccessPoint(admin, societyId, 'E2E Protocol Gate');
    accessPointId = accessPoint.id;
    const provisioned = await provisionDevice(admin, societyId, accessPointId, 'E2E Protocol Controller');
    deviceId = provisioned.device.id;
    deviceToken = provisioned.credentials.deviceToken;
    commandSecret = provisioned.credentials.commandSecret;
    commandTopicName = commandTopic(societyId, deviceId);
    acknowledgementTopic = `society/${societyId}/device/${deviceId}/acknowledgements`;

    resident = request.agent(server);
    await login(resident, USERS.residentA);

    client = mqtt.connect(BROKER_URL, {
      clientId: `societyos-protocol-test-${randomUUID().slice(0, 8)}`,
      username: process.env.MQTT_USERNAME?.trim() || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 5_000,
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      client.subscribe(commandTopicName, { qos: 1 }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => client?.end(true, () => resolve()));
    if (prisma && deviceId) {
      await prisma.idempotencyRecord
        .deleteMany({ where: { key: { startsWith: `access-verify:${deviceId}:` } } })
        .catch(() => undefined);
      await prisma.accessEvent
        .deleteMany({ where: { OR: [{ deviceId }, { passId: { in: passIds } }] } })
        .catch(() => undefined);
      await prisma.gateCommand.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceHealthLog.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceEvent.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceCredential.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.deviceAccessPoint.deleteMany({ where: { deviceId } }).catch(() => undefined);
      await prisma.device.deleteMany({ where: { id: deviceId } }).catch(() => undefined);
    }
    if (prisma && passIds.length > 0) {
      await prisma.visitorPassUse.deleteMany({ where: { passId: { in: passIds } } }).catch(() => undefined);
      await prisma.visitorApproval
        .deleteMany({ where: { passId: { in: passIds } } })
        .catch(() => undefined);
      await prisma.visitorPassCredential
        .deleteMany({ where: { passId: { in: passIds } } })
        .catch(() => undefined);
      await prisma.visitorPassAccessPoint
        .deleteMany({ where: { passId: { in: passIds } } })
        .catch(() => undefined);
      const passes = await prisma.visitorPass
        .findMany({ where: { id: { in: passIds } }, select: { visitorId: true } })
        .catch(() => []);
      await prisma.visitorPass.deleteMany({ where: { id: { in: passIds } } }).catch(() => undefined);
      await prisma.visitor
        .deleteMany({ where: { id: { in: passes.map((pass) => pass.visitorId) } } })
        .catch(() => undefined);
    }
    if (prisma && flatId) {
      await prisma.residentFlatMembership.deleteMany({ where: { flatId } }).catch(() => undefined);
      await prisma.flat.deleteMany({ where: { id: flatId } }).catch(() => undefined);
    }
    if (prisma && accessPointId) {
      await prisma.gateCommand.deleteMany({ where: { accessPointId } }).catch(() => undefined);
      await prisma.deviceAccessPoint.deleteMany({ where: { accessPointId } }).catch(() => undefined);
      await prisma.visitorPassAccessPoint
        .deleteMany({ where: { accessPointId } })
        .catch(() => undefined);
      await prisma.accessEvent.deleteMany({ where: { accessPointId } }).catch(() => undefined);
      await prisma.accessPoint.deleteMany({ where: { id: accessPointId } }).catch(() => undefined);
    }
    await app.close();
  });

  function nextCommand(timeoutMs = 5_000): Promise<SignedCommand> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off('message', onMessage);
        reject(new Error('Timed out waiting for a signed gate command'));
      }, timeoutMs);
      const onMessage = (topic: string, payload: Buffer) => {
        if (topic !== commandTopicName) return;
        clearTimeout(timer);
        client.off('message', onMessage);
        try {
          resolve(JSON.parse(payload.toString('utf8')) as SignedCommand);
        } catch (error) {
          reject(error);
        }
      };
      client.on('message', onMessage);
    });
  }

  function publish(topic: string, payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  function publishAck(command: SignedCommand, status: 'ACK' | 'EXECUTED', gateState?: string) {
    const ack: AckSignature = {
      commandId: command.commandId,
      status,
      nonce: command.nonce,
      ...(gateState ? { gateState } : {}),
      signedAt: new Date().toISOString(),
    };
    return publish(acknowledgementTopic, { ...ack, signature: signAck(ack, commandSecret) });
  }

  async function createProtocolPass(): Promise<{
    passId: string;
    pin: string;
    visitorName: string;
  }> {
    const visitorName = `Protocol Visitor ${uniqueSuffix()}`;
    const created = await createPass(resident, {
      flatId,
      accessPointId,
      name: visitorName,
    });
    passIds.push(created.pass.id);
    visitorNames.push(visitorName);
    return { passId: created.pass.id, pin: created.credentials.pin, visitorName };
  }

  async function deviceVerify(pin: string): Promise<{ decision: string; commandId?: string }> {
    const response = await request(server)
      .post('/api/v1/access/verify')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        accessPointId,
        credentialType: 'PIN',
        credential: pin,
        requestId: randomUUID(),
      })
      .expect(200);
    return response.body as { decision: string; commandId?: string };
  }

  it('authorizes a pass, signs the OPEN command and executes a signed acknowledgement', async () => {
    const created = await createProtocolPass();
    const commandPromise = nextCommand();
    const verification = await deviceVerify(created.pin);
    expect(verification.decision).toBe('AUTHORIZED');
    expect(verification.commandId).toEqual(expect.any(String));

    const command = await commandPromise;
    expect(command.commandId).toBe(verification.commandId);
    expect(command.deviceId).toBe(deviceId);
    expect(command.accessPointId).toBe(accessPointId);
    expect(command.type).toBe('OPEN');
    expect(command.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(verifyCommand(command, commandSecret, command.signature)).toBe(true);
    expect(verifyCommand(command, 'not-the-command-secret', command.signature)).toBe(false);

    const issuedAt = new Date(command.issuedAt).getTime();
    const expiresAt = new Date(command.expiresAt).getTime();
    expect(expiresAt - issuedAt).toBe(30_000);

    await publishAck(command, 'EXECUTED', 'OPEN');
    const executed = await waitFor(
      async () => {
        const row = await prisma.gateCommand.findUnique({ where: { id: command.commandId } });
        return row?.status === 'EXECUTED' ? row : false;
      },
      { label: 'EXECUTED acknowledgement' },
    );
    expect(executed.ackAt).not.toBeNull();
    expect(executed.executedAt).not.toBeNull();
    expect(executed.gateStateAtExec).toBe('OPEN');

    const stored = executed.signedPayload as unknown as SignedCommand;
    expect(stored).toMatchObject({
      commandId: command.commandId,
      signature: command.signature,
    });

    const event = await prisma.accessEvent.findFirst({
      where: { passId: created.passId },
      orderBy: { requestedAt: 'desc' },
    });
    expect(event).toMatchObject({ decision: 'AUTHORIZED', reasonCode: 'VALID_VISITOR_PASS' });
    expect(await prisma.visitorPassUse.count({ where: { passId: created.passId } })).toBe(1);

    const notification = await waitFor(
      () =>
        prisma.notification.findFirst({
          where: {
            societyId,
            template: 'VISITOR_ARRIVED',
            payload: { path: ['visitorName'], equals: created.visitorName },
          },
        }),
      { label: 'visitor arrival notification' },
    );
    expect(['PENDING', 'SENT']).toContain(notification.status);
  });

  it('drops out-of-scope and tampered acknowledgements, then accepts the valid one', async () => {
    const created = await createProtocolPass();
    const commandPromise = nextCommand();
    const verification = await deviceVerify(created.pin);
    expect(verification.decision).toBe('AUTHORIZED');
    const command = await commandPromise;

    // A signed acknowledgement addressed from a different device must be ignored.
    await publish(`society/${societyId}/device/${randomUUID()}/acknowledgements`, {
      commandId: command.commandId,
      status: 'EXECUTED',
      nonce: command.nonce,
      gateState: 'OPEN',
      signedAt: new Date().toISOString(),
      signature: 'not-a-signature',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await prisma.gateCommand.findUnique({ where: { id: command.commandId } }))?.status).toBe(
      'ISSUED',
    );

    // A validly-shaped but incorrectly signed acknowledgement is also ignored.
    const ack: AckSignature = {
      commandId: command.commandId,
      status: 'EXECUTED',
      nonce: command.nonce,
      gateState: 'OPEN',
      signedAt: new Date().toISOString(),
    };
    await publish(acknowledgementTopic, { ...ack, signature: 'tampered-signature' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await prisma.gateCommand.findUnique({ where: { id: command.commandId } }))?.status).toBe(
      'ISSUED',
    );

    await publishAck(command, 'ACK', 'OPENING');
    const acknowledged = await waitFor(
      async () => {
        const row = await prisma.gateCommand.findUnique({ where: { id: command.commandId } });
        return row?.status === 'ACKNOWLEDGED' ? row : false;
      },
      { label: 'ACKNOWLEDGED state' },
    );
    expect(acknowledged.ackAt).not.toBeNull();

    await publishAck(command, 'EXECUTED', 'OPEN');
    const executed = await waitFor(
      async () => {
        const row = await prisma.gateCommand.findUnique({ where: { id: command.commandId } });
        return row?.status === 'EXECUTED' ? row : false;
      },
      { label: 'EXECUTED state after ACK' },
    );
    expect(executed.gateStateAtExec).toBe('OPEN');
  });
});
