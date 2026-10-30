import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export interface AuditEntry {
  societyId?: string;
  actorUserId?: string;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Entries are never updated or deleted by the application.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          societyId: entry.societyId,
          actorUserId: entry.actorUserId,
          actorRole: entry.actorRole,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          meta: entry.meta as never,
        },
      });
    } catch (err) {
      // Audit must never break the request path; surface via logs.
      this.logger.error(`audit write failed for ${entry.action}: ${String(err)}`);
    }
  }
}
