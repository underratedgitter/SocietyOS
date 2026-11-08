import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { GateCommandType, GateState } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { getEnv } from '../config';
import {
  AckSignature,
  SignableCommand,
  decryptDeviceSecret,
  signCommand,
  verifyAck,
} from '../common/crypto.util';

export const commandTopic = (societyId: string, deviceId: string) =>
  `society/${societyId}/device/${deviceId}/commands`;

const DEVICE_TOPIC_RE = /^society\/([^/]+)\/device\/([^/]+)\/(telemetry|health|events|commands|acknowledgements)$/;
const ACK_STATUSES = new Set(['ACK', 'EXECUTED', 'FAILED']);
const GATE_STATES = new Set<GateState>(['CLOSED', 'OPENING', 'OPEN', 'CLOSING', 'STOPPED', 'FAULT', 'UNKNOWN']);
const EVENT_TYPES = new Set([
  'COMMAND_RECEIVED',
  'ACK',
  'STATE_CHANGED',
  'SENSOR',
  'HEARTBEAT',
  'TAMPER',
  'FAULT',
]);

interface ParsedDeviceTopic {
  societyId: string;
  deviceId: string;
  kind: string;
}

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: mqtt.MqttClient | null = null;
  private connectedFlag = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const env = getEnv();
    if (!env.mqttUrl) {
      this.logger.warn('MQTT_URL is not configured; device messaging is disabled');
      return;
    }
    this.client = mqtt.connect(env.mqttUrl, {
      clientId: `societyos-api-${Math.random().toString(16).slice(2, 12)}`,
      username: env.mqttUsername,
      password: env.mqttPassword,
      reconnectPeriod: 3000,
      connectTimeout: 5000,
      clean: true,
      protocolVersion: 5,
      rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
    });
    this.client.on('connect', () => {
      this.connectedFlag = true;
      this.logger.log('Connected to MQTT broker');
      this.client!.subscribe(
        [
          'society/+/device/+/acknowledgements',
          'society/+/device/+/events',
          'society/+/device/+/health',
          'society/+/device/+/telemetry',
        ],
        { qos: 1 },
        (error) => {
          if (error) this.logger.warn(`MQTT subscribe failed: ${error.message}`);
        },
      );
    });
    this.client.on('close', () => {
      this.connectedFlag = false;
    });
    this.client.on('error', (error) => this.logger.warn(`MQTT error: ${error.message}`));
    this.client.on('message', (topic, payload) => {
      void this.handleMessage(topic, payload);
    });
  }

  onModuleDestroy(): void {
    this.client?.end(true);
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  /**
   * Loads the command from the database, signs it with the device's rotated
   * command secret and publishes it at QoS 1. The raw command ID is never
   * trusted from the network; only ISSUED, unexpired commands are dispatched.
   */
  async publishCommand(commandId: string): Promise<{ topic: string; payload: SignableCommand & { signature: string } }> {
    if (!this.client || !this.connectedFlag) throw new Error('MQTT_BROKER_UNAVAILABLE');

    const command = await this.prisma.gateCommand.findUnique({
      where: { id: commandId },
      include: {
        device: {
          include: {
            credentials: {
              where: { revokedAt: null },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
        accessPoint: true,
      },
    });
    if (!command) throw new Error('COMMAND_NOT_FOUND');
    if (command.status !== 'ISSUED') throw new Error('COMMAND_NOT_DISPATCHABLE');
    if (command.expiresAt <= new Date()) throw new Error('COMMAND_EXPIRED');
    if (command.device.status !== 'ACTIVE') throw new Error('DEVICE_DISABLED');
    if (command.device.societyId !== command.accessPoint.societyId) throw new Error('COMMAND_SCOPE_MISMATCH');
    const link = await this.prisma.deviceAccessPoint.findUnique({
      where: {
        deviceId_accessPointId: {
          deviceId: command.deviceId,
          accessPointId: command.accessPointId,
        },
      },
    });
    if (!link) throw new Error('COMMAND_SCOPE_MISMATCH');

    const credential = command.device.credentials[0];
    if (!credential?.commandSecretEnc) throw new Error('DEVICE_COMMAND_KEY_MISSING');
    const secret = decryptDeviceSecret(credential.commandSecretEnc);

    const signable: SignableCommand = {
      commandId: command.id,
      deviceId: command.deviceId,
      accessPointId: command.accessPointId,
      type: command.type as GateCommandType,
      nonce: command.nonce,
      issuedAt: command.issuedAt.toISOString(),
      expiresAt: command.expiresAt.toISOString(),
    };
    const payload = { ...signable, signature: signCommand(signable, secret) };
    const topic = commandTopic(command.device.societyId, command.deviceId);

    // Persist the exact signed payload before publishing. If this write fails
    // no command reaches a gate; publishing first would let a gate open even
    // though the caller sees a failed dispatch and the use is compensated.
    await this.prisma.gateCommand.update({
      where: { id: command.id },
      data: { signedPayload: payload as never },
    });
    await this.publishRaw(topic, payload, 1);
    return { topic, payload };
  }

  private publishRaw(topic: string, payload: unknown, qos: 0 | 1): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connectedFlag) {
        reject(new Error('MQTT_BROKER_UNAVAILABLE'));
        return;
      }
      this.client.publish(topic, JSON.stringify(payload), { qos }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private parseTopic(topic: string): ParsedDeviceTopic | null {
    const match = DEVICE_TOPIC_RE.exec(topic);
    return match ? { societyId: match[1], deviceId: match[2], kind: match[3] } : null;
  }

  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    if (payload.length > 32 * 1024) {
      this.logger.warn(`Rejected oversized MQTT payload on ${topic}`);
      return;
    }
    const parsed = this.parseTopic(topic);
    if (!parsed) return;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    } catch {
      this.logger.warn(`Rejected non-JSON MQTT payload on ${topic}`);
      return;
    }
    try {
      if (parsed.kind === 'acknowledgements') await this.onAcknowledgement(parsed, body);
      else if (parsed.kind === 'events') await this.onDeviceEvent(parsed, body);
      else if (parsed.kind === 'health') await this.onHealth(parsed, body);
    } catch (error) {
      this.logger.error(`MQTT handling failed on ${topic}: ${String(error)}`);
    }
  }

  /**
   * Only ACTIVE devices may report. A disabled or revoked controller (decommissioned,
   * stolen, or with a leaked broker credential) must not keep writing events or looking
   * healthy via lastSeenAt; the HTTP device API already enforces the same rule.
   */
  private async loadDevice(parsed: ParsedDeviceTopic) {
    const device = await this.prisma.device.findFirst({
      where: { id: parsed.deviceId, societyId: parsed.societyId },
      select: { id: true, societyId: true, status: true },
    });
    if (device && device.status !== 'ACTIVE') {
      this.logger.warn(`Ignored ${parsed.kind} from ${device.status} device ${device.id}`);
      return null;
    }
    return device;
  }

  private async onAcknowledgement(parsed: ParsedDeviceTopic, body: Record<string, unknown>): Promise<void> {
    const commandId = typeof body.commandId === 'string' ? body.commandId : '';
    const status = typeof body.status === 'string' ? body.status : '';
    const nonce = typeof body.nonce === 'string' ? body.nonce : '';
    const signedAt = typeof body.signedAt === 'string' ? body.signedAt : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    const gateState = typeof body.gateState === 'string' ? body.gateState : undefined;
    if (!commandId || !ACK_STATUSES.has(status) || !nonce || !signedAt || !signature) {
      this.logger.warn(`Rejected malformed acknowledgement on ${parsed.deviceId}`);
      return;
    }
    if (gateState && !GATE_STATES.has(gateState as GateState)) {
      this.logger.warn(`Rejected invalid gate state in acknowledgement on ${parsed.deviceId}`);
      return;
    }

    const command = await this.prisma.gateCommand.findUnique({
      where: { id: commandId },
      include: {
        device: {
          include: {
            credentials: {
              where: { revokedAt: null },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });
    if (
      !command ||
      command.deviceId !== parsed.deviceId ||
      command.device.societyId !== parsed.societyId ||
      command.nonce !== nonce
    ) {
      this.logger.warn(`Rejected acknowledgement scope/nonce mismatch for ${commandId}`);
      return;
    }
    if (command.status !== 'ISSUED' && command.status !== 'ACKNOWLEDGED') return;

    const credential = command.device.credentials[0];
    if (!credential?.commandSecretEnc) return;
    const secret = decryptDeviceSecret(credential.commandSecretEnc);
    const ack: AckSignature = {
      commandId,
      status: status as AckSignature['status'],
      nonce,
      gateState,
      signedAt,
    };
    if (!verifyAck(ack, secret, signature)) {
      this.logger.warn(`Rejected acknowledgement with invalid signature for ${commandId}`);
      return;
    }

    const now = new Date();
    const data =
      status === 'FAILED'
        ? { status: 'FAILED' as const, ackAt: now }
        : status === 'EXECUTED'
          ? {
              status: 'EXECUTED' as const,
              ackAt: command.ackAt ?? now,
              executedAt: now,
              ...(gateState ? { gateStateAtExec: gateState as GateState } : {}),
            }
          : { status: 'ACKNOWLEDGED' as const, ackAt: now };
    await this.prisma.gateCommand.updateMany({
      where: {
        id: commandId,
        deviceId: parsed.deviceId,
        status: { in: ['ISSUED', 'ACKNOWLEDGED'] },
      },
      data,
    });
  }

  private async onDeviceEvent(parsed: ParsedDeviceTopic, body: Record<string, unknown>): Promise<void> {
    const device = await this.loadDevice(parsed);
    if (!device) {
      this.logger.warn(`Rejected event for unknown device ${parsed.deviceId}`);
      return;
    }
    const type = typeof body.type === 'string' && EVENT_TYPES.has(body.type) ? body.type : 'SENSOR';
    const accessPointId = typeof body.accessPointId === 'string' ? body.accessPointId : null;
    if (accessPointId) {
      const link = await this.prisma.deviceAccessPoint.findUnique({
        where: { deviceId_accessPointId: { deviceId: device.id, accessPointId } },
      });
      if (!link) {
        this.logger.warn(`Rejected event for unassigned access point ${accessPointId}`);
        return;
      }
    }
    const sequence = typeof body.sequence === 'number' && Number.isInteger(body.sequence) ? body.sequence : null;
    await this.prisma.deviceEvent.create({
      data: {
        deviceId: device.id,
        accessPointId,
        type: type as never,
        sequence,
        payload: body as never,
      },
    });
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  }

  private async onHealth(parsed: ParsedDeviceTopic, body: Record<string, unknown>): Promise<void> {
    const device = await this.loadDevice(parsed);
    if (!device) return;
    const uptime = typeof body.uptimeS === 'number' && Number.isInteger(body.uptimeS) ? body.uptimeS : null;
    const rssi = typeof body.rssi === 'number' && Number.isInteger(body.rssi) ? body.rssi : null;
    await this.prisma.$transaction([
      this.prisma.deviceHealthLog.create({
        data: {
          deviceId: device.id,
          online: body.online === undefined ? true : !!body.online,
          uptimeS: uptime,
          rssi,
          meta: body as never,
        },
      }),
      this.prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      }),
    ]);
  }
}
