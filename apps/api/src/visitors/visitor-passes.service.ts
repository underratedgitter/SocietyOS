import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, VisitorCategory } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { AuditService } from '../common/audit.service';
import { CredentialsService } from './credentials.service';
import { AuthedRequest } from '../auth/jwt-auth.guard';

const MAX_PASS_DURATION_DAYS = 30;
const MAX_PASSES_PER_FLAT_PER_DAY = 20;
/** Categories that require approval before activation (blueprint §6.D). */
const APPROVAL_CATEGORIES: VisitorCategory[] = ['DELIVERY', 'CAB'];

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
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  /** Effective status derives expiry dynamically (no sweep job needed for correctness). */
  effectiveStatus(pass: { status: string; validFrom: Date; validUntil: Date; usedCount: number; maxUses: number }): string {
    const now = Date.now();
    if (pass.status === 'REVOKED') return 'REVOKED';
    if (pass.status === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
    if (pass.status === 'DRAFT') return 'DRAFT';
    if (now < pass.validFrom.getTime() || now > pass.validUntil.getTime()) return 'EXPIRED';
    if (pass.usedCount >= pass.maxUses) return 'EXHAUSTED';
    return 'ACTIVE';
  }

  async create(req: AuthedRequest, dto: {
    flatId: string;
    visitor: { name: string; phone?: string };
    category: string;
    validFrom: string;
    validUntil: string;
    maxUses?: number;
    accessPointIds: string[];
  }) {
    const user = req.user!;
    const flat = await this.prisma.flat.findUnique({
      where: { id: dto.flatId },
      include: { building: { select: { societyId: true } } },
    });
    if (!flat) throw AppException.notFound('FLAT_NOT_FOUND');
    const societyId = flat.building.societyId;

    // Resource-level authorization: residents may only pass for their own flats.
    if (req.membership?.societyId !== societyId) throw AppException.forbidden('NOT_A_MEMBER');
    if (req.membership.role === 'RESIDENT') {
      const link = await this.prisma.residentFlatMembership.findUnique({
        where: { flatId_userId: { flatId: dto.flatId, userId: user.sub } },
      });
      if (!link) throw AppException.forbidden('NOT_YOUR_FLAT', 'You can only create passes for your own flat');
    } else if (req.membership.role !== 'SOCIETY_ADMIN') {
      throw AppException.forbidden('FORBIDDEN_ROLE', 'Guards cannot create visitor passes');
    }

    const validFrom = new Date(dto.validFrom);
    const validUntil = new Date(dto.validUntil);
    const maxUses = dto.maxUses ?? 1;
    this.assertPolicy(validFrom, validUntil, maxUses);

    // Invitation limit per flat per day.
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await this.prisma.visitorPass.count({
      where: { flatId: dto.flatId, createdAt: { gte: dayAgo } },
    });
    if (recent >= MAX_PASSES_PER_FLAT_PER_DAY) {
      throw AppException.unprocessable('INVITATION_LIMIT', 'Too many passes created for this flat today');
    }

    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { id: { in: dto.accessPointIds }, societyId },
    });
    if (accessPoints.length !== dto.accessPointIds.length) {
      throw AppException.unprocessable('ACCESS_POINT_NOT_IN_SOCIETY', 'All access points must belong to the pass society');
    }
    if (accessPoints.length === 0) {
      throw AppException.unprocessable('NO_ACCESS_POINTS', 'Select at least one access point');
    }

    // Dedupe visitor per society by phone (fallback: new visitor).
    let visitor = await this.prisma.visitor.findFirst({
      where: { societyId, phone: dto.visitor.phone ?? '\u0000', category: dto.category as VisitorCategory },
    });
    if (!visitor) {
      visitor = await this.prisma.visitor.create({
        data: {
          societyId,
          name: dto.visitor.name,
          phone: dto.visitor.phone,
          category: dto.category as VisitorCategory,
        },
      });
    }

    const requiresApproval = APPROVAL_CATEGORIES.includes(dto.category as VisitorCategory);
    const pin = this.credentials.generatePin();
    const qr = this.credentials.generateQrToken();

    const pass = await this.prisma.visitorPass.create({
      data: {
        societyId,
        flatId: dto.flatId,
        hostUserId: user.sub,
        visitorId: visitor.id,
        category: dto.category as VisitorCategory,
        status: requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE',
        validFrom,
        validUntil,
        maxUses,
        credentials: {
          create: [
            { type: pin.type, credentialHash: this.credentials.hash(pin.plaintext), keyId: this.credentials.keyVersion },
            { type: qr.type, credentialHash: this.credentials.hash(qr.plaintext), keyId: this.credentials.keyVersion },
          ],
        },
        accessPoints: { create: accessPoints.map((ap) => ({ accessPointId: ap.id })) },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      actorRole: req.membership?.role,
      action: 'VISITOR_PASS_CREATED',
      entityType: 'VisitorPass',
      entityId: pass.id,
      meta: { flatId: dto.flatId, category: dto.category, requiresApproval },
    });

    return {
      pass: await this.viewPass(pass.id),
      credentials: { pin: pin.plaintext, qrToken: qr.plaintext }, // shown once
    };
  }

  async list(req: AuthedRequest, filters: { societyId?: string; status?: string; flatId?: string }) {
    const user = req.user!;
    let where: Prisma.VisitorPassWhereInput = {};

    if (req.membership && (req.membership.role === 'SOCIETY_ADMIN' || req.membership.role === 'GUARD')) {
      where.societyId = filters.societyId ?? req.membership.societyId;
      if (filters.societyId && filters.societyId !== req.membership.societyId) {
        throw AppException.forbidden('NOT_A_MEMBER');
      }
    } else {
      // Residents see passes of their own flats across their societies.
      const flats = await this.prisma.residentFlatMembership.findMany({
        where: { userId: user.sub },
        select: { flatId: true },
      });
      where.flatId = { in: flats.map((f) => f.flatId) };
      if (filters.societyId) {
        const member = await this.prisma.societyMembership.findFirst({
          where: { societyId: filters.societyId, userId: user.sub, status: 'ACTIVE' },
        });
        if (!member) throw AppException.forbidden('NOT_A_MEMBER');
        where.societyId = filters.societyId;
      }
    }
    if (filters.flatId) where.flatId = filters.flatId;

    const passes = await this.prisma.visitorPass.findMany({
      where,
      include: passInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const views = passes.map((p) => this.toView(p));
    return filters.status ? views.filter((v) => v.effectiveStatus === filters.status) : views;
  }

  async getAuthorized(req: AuthedRequest, passId: string) {
    const pass = await this.loadPassOr404(passId);
    await this.assertCanManage(req, pass.societyId, pass.flatId, pass.hostUserId);
    return this.viewPass(passId);
  }

  async approve(req: AuthedRequest, passId: string, dto: { decision: 'APPROVED' | 'REJECTED'; reason?: string }) {
    const user = req.user!;
    const pass = await this.loadPassOr404(passId);
    await this.assertCanManage(req, pass.societyId, pass.flatId, pass.hostUserId);
    if (pass.status !== 'PENDING_APPROVAL') {
      throw AppException.conflict('NOT_PENDING', 'Pass is not awaiting approval');
    }

    const nextStatus = dto.decision === 'APPROVED' ? 'ACTIVE' : 'REVOKED';
    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.visitorPass.update({
        where: { id: passId },
        data: {
          status: nextStatus,
          ...(dto.decision === 'REJECTED' ? { revokedAt: new Date(), revokedBy: user.sub } : {}),
        },
      });
      await tx.visitorApproval.create({
        data: { passId, decidedById: user.sub, decision: dto.decision, reason: dto.reason },
      });
      return p;
    });

    await this.audit.record({
      societyId: pass.societyId,
      actorUserId: user.sub,
      actorRole: req.membership?.role,
      action: `VISITOR_PASS_${dto.decision}`,
      entityType: 'VisitorPass',
      entityId: passId,
      meta: { reason: dto.reason },
    });
    return this.viewPass(updated.id);
  }

  async revoke(req: AuthedRequest, passId: string) {
    const user = req.user!;
    const pass = await this.loadPassOr404(passId);
    await this.assertCanManage(req, pass.societyId, pass.flatId, pass.hostUserId);
    if (pass.status === 'REVOKED') return this.viewPass(passId);
    const updated = await this.prisma.visitorPass.update({
      where: { id: passId },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: user.sub },
    });
    await this.audit.record({
      societyId: pass.societyId,
      actorUserId: user.sub,
      actorRole: req.membership?.role,
      action: 'VISITOR_PASS_REVOKED',
      entityType: 'VisitorPass',
      entityId: passId,
    });
    return this.viewPass(updated.id);
  }

  async accessPointsForFlat(req: AuthedRequest, flatId: string) {
    const flat = await this.prisma.flat.findUnique({
      where: { id: flatId },
      include: { building: { select: { societyId: true } } },
    });
    if (!flat) throw AppException.notFound('FLAT_NOT_FOUND');
    const societyId = flat.building.societyId;
    if (req.membership?.societyId !== societyId) throw AppException.forbidden('NOT_A_MEMBER');
    return this.prisma.accessPoint.findMany({ where: { societyId }, orderBy: { name: 'asc' } });
  }

  private assertPolicy(validFrom: Date, validUntil: Date, maxUses: number) {
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime())) {
      throw AppException.unprocessable('INVALID_WINDOW', 'validFrom/validUntil must be ISO 8601 timestamps');
    }
    if (validFrom >= validUntil) {
      throw AppException.unprocessable('INVALID_WINDOW', 'validFrom must be before validUntil');
    }
    const days = (validUntil.getTime() - validFrom.getTime()) / (24 * 3600 * 1000);
    if (days > MAX_PASS_DURATION_DAYS) {
      throw AppException.unprocessable('PASS_TOO_LONG', `Pass window cannot exceed ${MAX_PASS_DURATION_DAYS} days`);
    }
    if (maxUses < 1 || maxUses > 10) {
      throw AppException.unprocessable('INVALID_MAX_USES', 'maxUses must be between 1 and 10');
    }
  }

  private async assertCanManage(req: AuthedRequest, societyId: string, flatId: string, hostUserId: string) {
    if (req.membership?.societyId !== societyId) throw AppException.forbidden('NOT_A_MEMBER');
    const role = req.membership.role;
    if (role === 'SOCIETY_ADMIN' || role === 'GUARD') return;
    if (role === 'RESIDENT') {
      if (req.user!.sub === hostUserId) return;
      const link = await this.prisma.residentFlatMembership.findUnique({
        where: { flatId_userId: { flatId, userId: req.user!.sub } },
      });
      if (link) return;
    }
    throw AppException.forbidden('NOT_YOUR_PASS', 'You cannot manage this pass');
  }

  private async loadPassOr404(passId: string) {
    const pass = await this.prisma.visitorPass.findUnique({ where: { id: passId } });
    if (!pass) throw AppException.notFound('PASS_NOT_FOUND');
    return pass;
  }

  async viewPass(passId: string): Promise<PassView> {
    const pass = await this.prisma.visitorPass.findUnique({
      where: { id: passId },
      include: passInclude,
    });
    if (!pass) throw AppException.notFound('PASS_NOT_FOUND');
    return this.toView(pass);
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
      accessPoints: pass.accessPoints.map((l) => ({
        id: l.accessPoint.id,
        name: l.accessPoint.name,
        type: l.accessPoint.type,
      })),
      requiresApproval: pass.status === 'PENDING_APPROVAL',
      createdAt: pass.createdAt,
      revokedAt: pass.revokedAt,
    };
  }
}

const passInclude = {
  visitor: { select: { id: true, name: true, phone: true } },
  flat: { include: { building: { select: { name: true } } } },
  host: { select: { id: true, name: true } },
  accessPoints: { include: { accessPoint: { select: { id: true, name: true, type: true } } } },
} satisfies Prisma.VisitorPassInclude;
