import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { PrismaService } from '../common/prisma.service';

export const commandTopic = (societyId: string, deviceId: string) =>
  `society/${societyId}/device/${deviceId}/commands`;

const DEVICE_TOPIC_RE = /^society\/([^/]+)\/device\/([^/]+)\/(telemetry|health|events|commands|acknowledgements)$/;

interface ParsedDeviceTopic {
  societyId: string;
  deviceId: string;
  kind: string;
}

/**
 * MQTT broker client for device messaging (blueprint §7 topic convention).
 * The API publishes commands and consumes acknowledgements, device events,
 * health and telemetry. Command acknowledgement and gate movement are recorded
 * as separate state transitions on the GateCommand row.
 */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: mqtt.MqttClient | null = null;
  private connectedFlag = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const url = process.env.MQTT_URL;
    if (!url) {
      this.logger.warn('MQTT_URL not configured; device messaging disabled');
      return;
    }
    this.client = mqtt.connect(url, {
      clientId: `societyos-api-${Math.random().toString(16).slice(2, 10)}`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      reconnectPeriod: 3000,
      clean: true,
    });
    this.client.on('connect', () => {
      this.connectedFlag = true;
      this.logger.log(`connected to MQTT broker at ${url}`);
      this.client!.subscribe(
        [
          'society/+/device/+/acknowledgements',
          'society/+/device/+/events',
          'society/+/device/+/health',
          'society/+/device/+/telemetry',
        ],
        { qos: 1 },
        (err) => {
          if (err) this.logger.warn(`subscribe failed: ${err.message}`);
        },
      );
    });
    this.client.on('close', () => (this.connectedFlag = false));
    this.client.on('error', (e) => this.logger.warn(`mqtt error: ${e.message}`));
    this.client.on('message', (topic, payload) => {
      void this.handleMessage(topic, payload);
    });
  }

  onModuleDestroy() {
    this.client?.end(true);
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  private parseTopic(topic: string): ParsedDeviceTopic | null {
    const m = DEVICE_TOPIC_RE.exec(topic);
    return m ? { societyId: m[1], deviceId: m[2], kind: m[3] } : null;
  }

  private async handleMessage(topic: string, payload: Buffer) {
    const parsed = this.parseTopic(topic);
    if (!parsed) return;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      this.logger.warn(`non-JSON payload on ${topic}`);
      return;
    }
    try {
      if (parsed.kind === 'acknowledgements') await this.onAcknowledgement(parsed, body);
      else if (parsed.kind === 'events') await this.onDeviceEvent(parsed, body);
      else if (parsed.kind === 'health') await this.onHealth(parsed, body);
    } catch (err) {
      this.logger.error(`handling ${topic} failed: ${String(err)}`);
    }
  }

  private async onAcknowledgement(t: ParsedDeviceTopic, body: Record<string, unknown>) {
    const commandId = body.commandId as string | undefined;
    const status = body.status as string | undefined;
    if (!commandId || !status) return;
    const map: Record<string, { status: 'ACKNOWLEDGED' | 'EXECUTED' | 'FAILED'; field: 'ackAt' | 'executedAt' | 'ackAt' }> = {
      ACK: { status: 'ACKNOWLEDGED', field: 'ackAt' },
      EXECUTED: { status: 'EXECUTED', field: 'executedAt' },
      FAILED: { status: 'FAILED', field: 'ackAt' },
    };
    const m = map[status];
    if (!m) return;
    const gateState = body.gateState as string | undefined;
    await this.prisma.gateCommand.update({
      where: { id: commandId },
      data: {
        status: m.status,
        ...(m.field === 'ackAt' ? { ackAt: new Date() } : { executedAt: new Date() }),
        ...(gateState ? { gateStateAtExec: gateState as never } : {}),
      },
    }).catch(() => undefined);
  }

  private async onDeviceEvent(t: ParsedDeviceTopic, body: Record<string, unknown>) {
    const type = (body.type as string) || 'SENSOR';
    await this.prisma.deviceEvent.create({
      data: {
        deviceId: t.deviceId,
        accessPointId: (body.accessPointId as string) || null,
        type: type as never,
        sequence: typeof body.sequence === 'number' ? body.sequence : null,
        payload: body as never,
      },
    });
    // Sensor-confirmed gate state also advances the originating command.
    const commandId = body.commandId as string | undefined;
    const gateState = body.gateState as string | undefined;
    if (commandId && gateState) {
      await this.prisma.gateCommand.update({
        where: { id: commandId },
        data: { status: 'EXECUTED', executedAt: new Date(), gateStateAtExec: gateState as never },
      }).catch(() => undefined);
    }
  }

  private async onHealth(t: ParsedDeviceTopic, body: Record<string, unknown>) {
    await this.prisma.$transaction([
      this.prisma.deviceHealthLog.create({
        data: {
          deviceId: t.deviceId,
          online: body.online === undefined ? true : !!body.online,
          uptimeS: typeof body.uptimeS === 'number' ? body.uptimeS : null,
          rssi: typeof body.rssi === 'number' ? body.rssi : null,
          meta: body as never,
        },
      }),
      this.prisma.device.update({
        where: { id: t.deviceId },
        data: { lastSeenAt: new Date() },
      }),
    ]);
  }

  /** Publish a command; rejects when the broker is unreachable (fail-closed). */
  publish(topic: string, payload: unknown, qos: 0 | 1 = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connectedFlag) {
        return reject(new Error('MQTT_BROKER_UNAVAILABLE'));
      }
      this.client.publish(topic, JSON.stringify(payload), { qos }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}
