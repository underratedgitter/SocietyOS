import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Small, bounded maintenance loop for a pilot deployment. It never opens a
 * gate; it only advances persisted state that is already past its deadline.
 * In a multi-replica production deployment this should move to BullMQ with a
 * distributed lock; the conditional updates here are idempotent.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), 15_000);
    this.timer.unref?.();
    setTimeout(() => void this.sweep(), 2_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const expiredCommands = await this.prisma.gateCommand.updateMany({
        where: { status: { in: ['ISSUED', 'ACKNOWLEDGED'] }, expiresAt: { lt: now } },
        data: { status: 'EXPIRED' },
      });
      if (expiredCommands.count > 0) {
        await this.prisma.securityAlert.create({
          data: {
            severity: 'INFO',
            type: 'GATE_COMMANDS_EXPIRED',
            detail: { count: expiredCommands.count, sweptAt: now.toISOString() } as never,
          },
        }).catch(() => undefined);
      }

      await this.prisma.visitorPass.updateMany({
        where: { status: 'ACTIVE', validUntil: { lt: now } },
        data: { status: 'EXPIRED' },
      });

      const exhausted = await this.prisma.visitorPass.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, usedCount: true, maxUses: true },
        take: 500,
      });
      const exhaustedIds = exhausted.filter((pass) => pass.usedCount >= pass.maxUses).map((pass) => pass.id);
      if (exhaustedIds.length > 0) {
        await this.prisma.visitorPass.updateMany({
          where: { id: { in: exhaustedIds }, status: 'ACTIVE' },
          data: { status: 'EXHAUSTED' },
        });
      }
      // India DPDP Act 2023: Anonymize visitor records past 90-day storage retention window
      const retentionCutoff = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
      await this.prisma.visitor.updateMany({
        where: {
          createdAt: { lt: retentionCutoff },
          name: { not: 'ANONYMIZED_VISITOR' },
        },
        data: {
          name: 'ANONYMIZED_VISITOR',
          phone: null,
        },
      });

      // Delete credentials of passes expired or revoked more than N days ago (default 30)
      const retentionDays = Number.parseInt(process.env.CREDENTIAL_RETENTION_DAYS || '30', 10);
      const credCutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
      await this.prisma.visitorPassCredential.deleteMany({
        where: {
          pass: {
            OR: [
              { status: 'EXPIRED', validUntil: { lt: credCutoff } },
              { status: 'REVOKED', revokedAt: { lt: credCutoff } },
            ],
          },
        },
      });

      await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
      await this.prisma.session.deleteMany({
        where: { expiresAt: { lt: new Date(now.getTime() - 7 * 24 * 3600 * 1000) } },
      });
    } catch (error) {
      this.logger.warn(`Maintenance sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
