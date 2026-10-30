import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { RateLimitService } from './common/rate-limit.service';
import { MqttService } from './devices/mqtt.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly mqtt: MqttService,
  ) {}

  @Get('healthz')
  healthz() {
    return { status: 'ok', service: 'societyos-api', time: new Date().toISOString() };
  }

  @Get('readyz')
  async readyz() {
    const components: Record<string, string> = {};
    let ready = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      components.database = 'ok';
    } catch {
      components.database = 'down';
      ready = false;
    }
    components.redis = this.rateLimit.redisReady ? 'ok' : 'degraded';
    components.mqtt = this.mqtt.connected ? 'ok' : 'degraded';
    return { status: ready ? 'ready' : 'not-ready', components, time: new Date().toISOString() };
  }
}
