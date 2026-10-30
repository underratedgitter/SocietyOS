import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Transactional outbox (blueprint §9 Stage 2): notifications are written in the
 * same logical flow as the business event, then drained by a retryable worker.
 * Actual FCM/SMS providers are Stage 6 — delivery is currently simulated.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.drain(), 5000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(input: {
    societyId?: string;
    userId?: string;
    channel: 'PUSH' | 'SMS' | 'EMAIL';
    template: string;
    payload: Record<string, unknown>;
  }) {
    await this.prisma.notification.create({
      data: {
        societyId: input.societyId,
        userId: input.userId,
        channel: input.channel,
        template: input.template,
        payload: input.payload as never,
      },
    });
  }

  private async drain() {
    try {
      const pending = await this.prisma.notification.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const n of pending) {
        // Provider integration (FCM / SMS) arrives with Stage 6.
        this.logger.log(
          `deliver(${n.channel}) ${n.template} -> user=${n.userId ?? '-'} ${JSON.stringify(n.payload)}`,
        );
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
      }
    } catch (err) {
      this.logger.warn(`outbox drain failed: ${String(err)}`);
    }
  }
}
