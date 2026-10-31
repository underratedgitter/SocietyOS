import { Injectable } from '@nestjs/common';
import { Prisma, VisitorCategory } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AuthzService } from '../common/authz.service';
import { AppException } from '../common/app.exception';
import { AuditService } from '../common/audit.service';
import { JwtUser } from '../auth/jwt-auth.guard';
import { CredentialsService } from './credentials.service';
import { visitorPolicy } from '../societies/policy';
import { CreateVisitorPassDto, ListPassesQueryDto } from './visitor-passes.dto';

const MAX_CREDENTIAL_ATTEMPTS = 5;

export interface PassView {
  id: string;
  societyId: string;
  status: string;
  effectiveStatus: string;
  category: VisitorCategory;
  visitor: { id: string; name: string; phone: string | null };
  flat: { id: string; flatNumber: string; building: string };
  host: { id: string; name: string };
  validFrom: Date;
  validUntil: Date;
  maxUses: number;
  usedCount: number;
  accessPoints: { id: string; name: string; type: string }[];
  requiresApproval: boolean;
  createdAt: Date;
  revokedAt?: Date | null;
}

@Injectable()
export class VisitorPassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  effectiveStatus(pass: {
    status: string;
    validFrom: Date;
    validUntil: Date;
    usedCount: number;
    maxUses: number;
  }): string {
    const now = Date.now();
    if (pass.status === 'REVOKED') return 'REVOKED';
    if (pass.status === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
    if (pass.status === 'DRAFT') return 'DRAFT';
    if (pass.status === 'EXPIRED') return 'EXPIRED';
    if (pass.status === 'EXHAUSTED') return 'EXHAUSTED';
    if (now < pass.validFrom.getTime()) return 'SCHEDULED';
    if (now > pass.validUntil.getTime()) return 'EXPIRED';
    if (pass.usedCount >= pass.maxUses) return 'EXHAUSTED';
    return 'ACTIVE';
  }

  async create(caller: JwtUser, dto: CreateVisitorPassDto) {
    const context = await this.authz.flat(caller.sub, dto.flatId, ['SOCIETY_ADMIN', 'RESIDENT']);
    const society = await this.prisma.society.findUnique({
      where: { id: context.societyId },
      select: { settings: true },
    });
    if (!society) throw AppException.notFound('SOCIETY_NOT_FOUND');
    const policy = visitorPolicy(society.settings);

    const now = new Date();
    const requestedFrom = new Date(dto.validFrom);
    const validUntil = new Date(dto.validUntil);
    if (Number.isNaN(requestedFrom.getTime()) || Number.isNaN(validUntil.getTime())) {
      throw AppException.unprocessable('INVALID_WINDOW', 'validFrom and validUntil must be ISO timestamps');
    }
    const validFrom = requestedFrom < now ? now : requestedFrom;
    if (validUntil <= now) {
      throw AppException.unprocessable('INVALID_WINDOW', 'Pass must end in the future');
    }
    if (validUntil <= validFrom) {
      throw AppException.unprocessable('INVALID_WINDOW', 'validFrom must be before validUntil');
    }
    const durationHours = (validUntil.getTime() - validFrom.getTime()) / 3_600_000;
    if (durationHours > policy.maxPassDurationHours) {
      throw AppException.unprocessable(
        'PASS_TOO_LONG',
        `This society allows passes of at most ${policy.maxPassDurationHours} hours`,
      );
    }
    const maxUses = dto.maxUses ?? 1;
    if (maxUses > policy.maxUsesPerPass) {
      throw AppException.unprocessable(
        'INVALID_MAX_USES',
        `This society allows at most ${policy.maxUsesPerPass} uses per pass`,
      );
    }

    const recent = await this.prisma.visitorPass.count({
      where: { flatId: dto.flatId, createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) } },
    });
    if (recent >= policy.maxPassesPerFlatPerDay) {
      throw AppException.unprocessable('INVITATION_LIMIT', 'Too many passes created for this flat today');
    }

    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { id: { in: dto.accessPointIds }, societyId: context.societyId },
      select: { id: true },
    });
    if (accessPoints.length !== dto.accessPointIds.length) {
      throw AppException.unprocessable(
        'ACCESS_POINT_NOT_IN_SOCIETY',
        'Every selected access point must belong to this society',
      );
    }

    const approvalRequired = policy.approvalCategories.includes(dto.category as VisitorCategory);
    const status = approvalRequired ? 'PENDING_APPROVAL' : 'ACTIVE';
    const phone = dto.visitor.phone?.trim() || null;
    const visitorName = dto.visitor.name.trim();

    for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
      const pin = this.credentials.generatePin();
      const qr = this.credentials.generateQrToken();
      try {
        const pass = await this.prisma.$transaction(async (tx) => {
          let visitor = await tx.visitor.findFirst({
            where: {
              societyId: context.societyId,
              name: visitorName,
              phone,
              category: dto.category as VisitorCategory,
            },
          });
          if (!visitor) {
            visitor = await tx.visitor.create({
              data: {
                societyId: context.societyId,
                name: visitorName,
                phone,
                category: dto.category as VisitorCategory,
              },
            });
          }
          const created = await tx.visitorPass.create({
            data: {
              societyId: context.societyId,
              flatId: dto.flatId,
              hostUserId: caller.sub,
              visitorId: visitor.id,
              category: dto.category as VisitorCategory,
              status,
              validFrom,
              validUntil,
              maxUses,
              credentials: {
                create: [
                  {
                    type: pin.type,
                    credentialHash: this.credentials.hash(pin.plaintext),
                    keyId: this.credentials.keyVersion,
                  },
                  {
                    type: qr.type,
                    credentialHash: this.credentials.hash(qr.plaintext),
                    keyId: this.credentials.keyVersion,
                  },
                ],
              },
              accessPoints: {
                create: accessPoints.map((accessPoint) => ({ accessPointId: accessPoint.id })),
              },
            },
          });
          await tx.auditLog.create({
            data: {
              societyId: context.societyId,
              actorUserId: caller.sub,
              actorRole: context.role,
              action: 'VISITOR_PASS_CREATED',
              entityType: 'VisitorPass',
              entityId: created.id,
              meta: { flatId: dto.flatId, category: dto.category, requiresApproval: approvalRequired },
            },
          });
          return created;
        });

        return {
          pass: await this.viewPass(pass.id),
          credentials: { pin: pin.plaintext, qrToken: qr.plaintext },
        };
      } catch (error) {
        if (this.isCredentialCollision(error) && attempt < MAX_CREDENTIAL_ATTEMPTS - 1) continue;
        throw error;
      }
    }
    throw AppException.conflict('CREDENTIAL_GENERATION_FAILED', 'Could not allocate a unique pass credential. Try again.');
  }

  async list(caller: JwtUser, query: ListPassesQueryDto) {
    const limit = query.limit ?? 50;
    const where: Prisma.VisitorPassWhereInput = {};
    const ownFlats = await this.prisma.residentFlatMembership.findMany({
      where: { userId: caller.sub, endedAt: null },
      select: { flatId: true },
    });
    const ownFlatIds = ownFlats.map((link) => link.flatId);

    if (query.societyId) {
      const context = await this.authz.society(caller.sub, query.societyId);
      if (context.role === 'RESIDENT') {
        where.societyId = query.societyId;
        where.flatId = { in: ownFlatIds };
        if (query.flatId && !ownFlatIds.includes(query.flatId)) {
          throw AppException.forbidden('NOT_YOUR_FLAT', 'You can only view passes for your own flats');
        }
      } else {
        where.societyId = query.societyId;
        if (query.flatId) {
          const flat = await this.prisma.flat.findFirst({
            where: { id: query.flatId, building: { societyId: query.societyId } },
            select: { id: true },
          });
          if (!flat) throw AppException.forbidden('FLAT_NOT_IN_SOCIETY', 'Flat is not in this society');
        }
      }
      if (query.flatId) where.flatId = query.flatId;
    } else {
      const memberships = await this.prisma.societyMembership.findMany({
        where: { userId: caller.sub, status: 'ACTIVE' },
        select: { societyId: true, role: true },
      });
      const staffSocieties = memberships.filter((m) => m.role !== 'RESIDENT').map((m) => m.societyId);
      const residentSocieties = memberships.filter((m) => m.role === 'RESIDENT').map((m) => m.societyId);
      const scopes: Prisma.VisitorPassWhereInput[] = [];
      if (staffSocieties.length > 0) scopes.push({ societyId: { in: staffSocieties } });
      if (residentSocieties.length > 0) scopes.push({ flatId: { in: ownFlatIds } });
      if (scopes.length === 0) return { items: [], nextCursor: null };
      where.OR = scopes;
      if (query.flatId) {
        if (!ownFlatIds.includes(query.flatId)) {
          throw AppException.forbidden('NOT_YOUR_FLAT', 'You can only view passes for your own flats');
        }
        where.flatId = query.flatId;
      }
    }

    const rows = await this.prisma.visitorPass.findMany({
      where,
      include: passInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: Math.min(limit * 3, 300),
    });
    let views = rows.map((pass) => this.toView(pass));
    if (query.status) views = views.filter((view) => view.effectiveStatus === query.status);
    const items = views.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? rows[limit - 1]?.id ?? null : null,
    };
  }

  async getAuthorized(caller: JwtUser, passId: string) {
    const pass = await this.loadPassOr404(passId);
    await this.assertCanManage(caller, pass);
    return this.viewPass(passId);
  }

  async approve(
    caller: JwtUser,
    passId: string,
    dto: { decision: 'APPROVED' | 'REJECTED'; reason?: string },
  ) {
    const pass = await this.loadPassOr404(passId);
    const context = await this.assertCanManage(caller, pass);
    if (pass.status !== 'PENDING_APPROVAL') {
      throw AppException.conflict('NOT_PENDING', 'Pass is not awaiting approval');
    }
    const nextStatus = dto.decision === 'APPROVED' ? 'ACTIVE' : 'REVOKED';
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.visitorPass.updateMany({
        where: { id: passId, status: 'PENDING_APPROVAL' },
        data: {
          status: nextStatus,
          ...(nextStatus === 'REVOKED' ? { revokedAt: new Date(), revokedBy: caller.sub } : {}),
        },
      });
      if (changed.count !== 1) {
        throw AppException.conflict('NOT_PENDING', 'Pass is no longer awaiting approval');
      }
      await tx.visitorApproval.create({
        data: {
          passId,
          decidedById: caller.sub,
          decision: dto.decision,
          reason: dto.reason?.trim() || null,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: pass.societyId,
          actorUserId: caller.sub,
          actorRole: context.role,
          action: `VISITOR_PASS_${dto.decision}`,
          entityType: 'VisitorPass',
          entityId: passId,
          meta: { reason: dto.reason || null },
        },
      });
      return tx.visitorPass.findUniqueOrThrow({ where: { id: passId }, include: passInclude });
    });
    return this.toView(updated);
  }

  async revoke(caller: JwtUser, passId: string, reason?: string) {
    const pass = await this.loadPassOr404(passId);
    const context = await this.assertCanManage(caller, pass);
    if (pass.status === 'REVOKED') return this.viewPass(passId);
    await this.prisma.$transaction(async (tx) => {
      await tx.visitorPass.update({
        where: { id: passId },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: caller.sub },
      });
      await tx.auditLog.create({
        data: {
          societyId: pass.societyId,
          actorUserId: caller.sub,
          actorRole: context.role,
          action: 'VISITOR_PASS_REVOKED',
          entityType: 'VisitorPass',
          entityId: passId,
          meta: { reason: reason?.trim() || null },
        },
      });
    });
    return this.viewPass(passId);
  }

  async accessPointsForFlat(caller: JwtUser, flatId: string) {
    const context = await this.authz.flat(caller.sub, flatId, ['SOCIETY_ADMIN', 'RESIDENT', 'GUARD']);
    return this.prisma.accessPoint.findMany({
      where: { societyId: context.societyId },
      select: { id: true, name: true, type: true, location: true },
      orderBy: { name: 'asc' },
    });
  }

  async viewPass(passId: string): Promise<PassView> {
    const pass = await this.prisma.visitorPass.findUnique({
      where: { id: passId },
      include: passInclude,
    });
    if (!pass) throw AppException.notFound('PASS_NOT_FOUND', 'Visitor pass not found');
    return this.toView(pass);
  }

  private async assertCanManage(caller: JwtUser, pass: { societyId: string; flatId: string; hostUserId: string }) {
    const context = await this.authz.society(caller.sub, pass.societyId);
    if (context.role === 'SOCIETY_ADMIN' || context.role === 'GUARD') return context;
    if (context.role === 'RESIDENT') {
      if (pass.hostUserId === caller.sub) return context;
      const link = await this.prisma.residentFlatMembership.findFirst({
        where: { flatId: pass.flatId, userId: caller.sub, endedAt: null },
      });
      if (link) return context;
    }
    throw AppException.forbidden('NOT_YOUR_PASS', 'You cannot manage this pass');
  }

  private async loadPassOr404(passId: string) {
    const pass = await this.prisma.visitorPass.findUnique({ where: { id: passId } });
    if (!pass) throw AppException.notFound('PASS_NOT_FOUND', 'Visitor pass not found');
    return pass;
  }

  private toView(pass: Prisma.VisitorPassGetPayload<{ include: typeof passInclude }>): PassView {
    return {
      id: pass.id,
      societyId: pass.societyId,
      status: pass.status,
      effectiveStatus: this.effectiveStatus(pass),
      category: pass.category,
      visitor: { id: pass.visitor.id, name: pass.visitor.name, phone: pass.visitor.phone },
      flat: {
        id: pass.flat.id,
        flatNumber: pass.flat.flatNumber,
        building: pass.flat.building.name,
      },
      host: { id: pass.host.id, name: pass.host.name },
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      maxUses: pass.maxUses,
      usedCount: pass.usedCount,
      accessPoints: pass.accessPoints.map((link) => ({
        id: link.accessPoint.id,
        name: link.accessPoint.name,
        type: link.accessPoint.type,
      })),
      requiresApproval: pass.status === 'PENDING_APPROVAL',
      createdAt: pass.createdAt,
      revokedAt: pass.revokedAt,
    };
  }

  private isCredentialCollision(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');
    return fields.includes('credentialHash');
  }
}

const passInclude = {
  visitor: { select: { id: true, name: true, phone: true } },
  flat: { include: { building: { select: { name: true } } } },
  host: { select: { id: true, name: true } },
  accessPoints: { include: { accessPoint: { select: { id: true, name: true, type: true } } } },
} satisfies Prisma.VisitorPassInclude;
