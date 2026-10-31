import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { getEnv } from '../config';

const MAX_ATTEMPTS = 5;

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), 5000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(input: {
    societyId?: string;
    userId?: string;
    channel: 'PUSH' | 'SMS' | 'EMAIL';
    template: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.notification.create({
      data: {
        societyId: input.societyId,
        userId: input.userId,
        channel: input.channel,
        template: input.template,
        payload: input.payload as never,
        nextAttemptAt: new Date(),
      },
    });
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const pending = await this.prisma.notification.findMany({
        where: {
          status: 'PENDING',
          attempts: { lt: MAX_ATTEMPTS },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const notification of pending) {
        const claimed = await this.prisma.notification.updateMany({
          where: {
            id: notification.id,
            status: 'PENDING',
            attempts: notification.attempts,
          },
          data: {
            attempts: { increment: 1 },
            nextAttemptAt: new Date(Date.now() + 60_000),
          },
        });
        if (claimed.count !== 1) continue;

        try {
          await this.deliver(notification.channel, notification.template, notification.payload);
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { status: 'SENT', sentAt: new Date(), lastError: null, nextAttemptAt: null },
          });
        } catch (error) {
          const attempts = notification.attempts + 1;
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: {
              status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
              lastError: String(error).slice(0, 500),
              nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + 60_000 * attempts),
            },
          });
          this.logger.warn(`Notification ${notification.id} delivery failed (attempt ${attempts})`);
        }
      }
    } catch (error) {
      this.logger.warn(`Outbox drain failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async deliver(
    channel: 'PUSH' | 'SMS' | 'EMAIL',
    template: string,
    payload: unknown,
  ): Promise<void> {
    const env = getEnv();
    if (!env.notificationWebhookUrl) {
      // Development/MVP transport: the outbox is still durable and visible in
      // the database. Stage 6 replaces this with FCM/SMS providers.
      this.logger.log(`Notification queued (${channel}/${template})`);
      return;
    }
    const body = JSON.stringify({ channel, template, payload });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (env.notificationWebhookSecret) {
      headers['x-societyos-signature'] = createHmac('sha256', env.notificationWebhookSecret)
        .update(body)
        .digest('hex');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(env.notificationWebhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Notification provider returned ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
