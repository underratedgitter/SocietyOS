import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from './common/prisma.service';
import { RateLimitService } from './common/rate-limit.service';
import { MqttService } from './devices/mqtt.service';
import { getEnv } from './config';

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
    // In production rate limiting fails closed without Redis, so the replica
    // must leave the load balancer rather than 429 every sign-in.
    const rateLimitReady = this.rateLimit.healthy;
    components.redis = this.rateLimit.redisReady ? 'ok' : rateLimitReady ? 'degraded' : 'down';
    components.mqtt = this.mqtt.connected ? 'ok' : 'degraded';

    try {
      const failedCount = await this.prisma.notification.count({
        where: { status: 'FAILED' },
      });
      components.notificationsOutbox = failedCount > 50 ? 'alert_deadletters' : 'ok';
    } catch {
      components.notificationsOutbox = 'unknown';
    }

    const env = getEnv();
    components.smsProvider = env.smsProvider;
    components.whatsappProvider = env.whatsappProvider;
    components.paymentGateway = env.razorpayKeyId
      ? 'razorpay'
      : env.stripeSecretKey
        ? 'stripe'
        : 'mock';

    const ready = databaseReady && rateLimitReady;
    res.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not-ready',
      components,
      time: new Date().toISOString(),
    };
  }
}
