import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
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
    return { status: 'ok', service: 'societyos-api', version: '1.0.0', time: new Date().toISOString() };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: true }) res: Response) {
    const components: Record<string, string> = {};
    let databaseReady = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      components.database = 'ok';
    } catch {
      components.database = 'down';
      databaseReady = false;
    }
    components.redis = this.rateLimit.redisReady ? 'ok' : 'degraded';
    components.mqtt = this.mqtt.connected ? 'ok' : 'degraded';
    res.status(databaseReady ? 200 : 503);
    return {
      status: databaseReady ? 'ready' : 'not-ready',
      components,
      time: new Date().toISOString(),
    };
  }
}
