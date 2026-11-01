import { Injectable } from '@nestjs/common';
import { VisitorCategory } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppException } from '../common/app.exception';
import { PrismaService } from '../common/prisma.service';
import { AuthService } from '../auth/auth.service';
import { CredentialsService } from '../visitors/credentials.service';
import { RateLimitService } from '../common/rate-limit.service';
import { AuditService } from '../common/audit.service';
import { visitorPolicy } from '../societies/policy';
import { RegisterUserDto, SelfRegisterVisitorDto } from './registration.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly credentials: CredentialsService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async listPublicSocieties() {
    return this.prisma.society.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async listPublicFlats(societyId: string) {
    const flats = await this.prisma.flat.findMany({
      where: { building: { societyId } },
      include: {
        building: {
          select: { id: true, name: true },
        },
      },
      orderBy: [{ building: { name: 'asc' } }, { flatNumber: 'asc' }],
    });

    return flats.map((flat) => ({
      id: flat.id,
      buildingId: flat.building.id,
      buildingName: flat.building.name,
      flatNumber: flat.flatNumber,
      label: `${flat.building.name} · Flat ${flat.flatNumber}`,
    }));
  }

  async registerUser(dto: RegisterUserDto, userAgent?: string) {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw AppException.conflict('EMAIL_IN_USE', 'An account with this email address already exists');
    }

    const phone = dto.phone?.trim() || null;
    if (phone) {
      const existingPhone = await this.prisma.user.findFirst({ where: { phone } });
      if (existingPhone) {
        throw AppException.conflict('PHONE_IN_USE', 'An account with this phone number already exists');
      }
    }

    const society = await this.prisma.society.findUnique({
      where: { id: dto.societyId },
      select: { id: true, name: true },
    });
    if (!society) {
      throw AppException.notFound('SOCIETY_NOT_FOUND', 'Selected society does not exist');
    }

    let flatInfo: { id: string; flatNumber: string; buildingName: string } | null = null;
    if (dto.flatId) {
      const flat = await this.prisma.flat.findUnique({
        where: { id: dto.flatId },
        include: { building: true },
      });
      if (!flat || flat.building.societyId !== dto.societyId) {
        throw AppException.unprocessable('INVALID_FLAT', 'The selected flat does not belong to this society');
      }
      flatInfo = {
        id: flat.id,
        flatNumber: flat.flatNumber,
        buildingName: flat.building.name,
      };
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          email,
          phone: dto.phone?.trim() || null,
          passwordHash,
          isPlatformAdmin: false,
          mustChangePassword: false,
        },
      });

      await tx.societyMembership.create({
        data: {
          userId: user.id,
          societyId: dto.societyId,
          role: 'RESIDENT',
          status: 'ACTIVE',
        },
      });

      if (dto.flatId) {
        await tx.residentFlatMembership.create({
          data: {
            flatId: dto.flatId,
            userId: user.id,
            relationship: dto.relationship || 'FAMILY',
          },
        });
      }

      const tokens = await this.auth.issueSessionTokens(user, userAgent, tx);
      return { user, tokens };
    });

    await this.audit.record({
      societyId: dto.societyId,
      actorUserId: result.user.id,
      action: 'USER_REGISTERED',
      entityType: 'User',
      entityId: result.user.id,
      meta: { email, hasFlat: Boolean(dto.flatId) },
    }).catch(() => undefined);

    return {
      user: this.auth.toSafeUser(result.user),
      tokens: result.tokens,
      society,
      flat: flatInfo
        ? {
            ...flatInfo,
            relationship: dto.relationship || 'FAMILY',
          }
        : undefined,
    };
  }

  async selfRegisterVisitor(dto: SelfRegisterVisitorDto, ip = 'unknown') {
    const rateLimitKey = `visitor:self-register:ip:${ip}`;
    const limit = await this.rateLimit.hit(rateLimitKey, 15, 15 * 60);
    if (!limit.allowed) {
      throw AppException.tooMany('Too many visitor registration attempts. Please wait a few minutes.');
    }

    const flat = await this.prisma.flat.findUnique({
      where: { id: dto.flatId },
      include: {
        building: {
          include: {
            society: { select: { id: true, name: true, settings: true } },
          },
        },
      },
    });

    if (!flat || flat.building.societyId !== dto.societyId) {
      throw AppException.unprocessable('INVALID_FLAT', 'The selected flat does not belong to this society');
    }

    const society = flat.building.society;
    const policy = visitorPolicy(society.settings);

    const now = new Date();
    const recentPasses = await this.prisma.visitorPass.count({
      where: {
        flatId: dto.flatId,
        createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) },
      },
    });
    if (recentPasses >= policy.maxPassesPerFlatPerDay) {
      throw AppException.unprocessable('INVITATION_LIMIT', 'Daily visitor pass capacity reached for this flat');
    }

    // Determine duration based on category or requested duration
    let durationMinutes = 240; // 4 hours default
    if (dto.category === 'RELATIVE') {
      durationMinutes = Math.min(policy.maxPassDurationHours * 60, 24 * 60); // 24 hours
    } else if (dto.category === 'DELIVERY' || dto.category === 'CAB') {
      durationMinutes = 30; // 30 minutes
    } else if (dto.category === 'MAINTENANCE') {
      durationMinutes = 480; // 8 hours
    }

    if (dto.expectedDurationMinutes) {
      const maxMinutes = policy.maxPassDurationHours * 60;
      durationMinutes = Math.min(maxMinutes, Math.max(15, dto.expectedDurationMinutes));
    }

    const validFrom = now;
    const validUntil = new Date(now.getTime() + durationMinutes * 60 * 1000);

    // Find host user in the flat or fall back to an active society admin
    const hostMembership = await this.prisma.residentFlatMembership.findFirst({
      where: { flatId: dto.flatId, endedAt: null },
      select: { userId: true },
    });

    let hostUserId = hostMembership?.userId;
    if (!hostUserId) {
      const adminMembership = await this.prisma.societyMembership.findFirst({
        where: { societyId: dto.societyId, role: 'SOCIETY_ADMIN', status: 'ACTIVE' },
        select: { userId: true },
      });
      if (!adminMembership) {
        throw AppException.unprocessable('NO_HOST_AVAILABLE', 'No active resident or administrator found for this society flat');
      }
      hostUserId = adminMembership.userId;
    }

    // Access points in the society
    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { societyId: dto.societyId },
      select: { id: true, name: true, type: true },
    });
    if (accessPoints.length === 0) {
      throw AppException.unprocessable('NO_GATES_CONFIGURED', 'No active gates configured for this society');
    }

    const requiresApproval = policy.approvalCategories.includes(dto.category as VisitorCategory);
    const status = requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE';

    const trimmedName = dto.visitorName.trim();
    const trimmedVehicle = dto.vehicle?.trim().toUpperCase();
    const finalVisitorName = trimmedVehicle
      ? `${trimmedName} [${trimmedVehicle}]`.slice(0, 120)
      : trimmedName;
    const phone = dto.visitorPhone?.trim() || null;

    const pin = this.credentials.generatePin();
    const qr = this.credentials.generateQrToken();
    const maxUses = dto.category === 'RELATIVE' ? Math.min(policy.maxUsesPerPass, 5) : 1;

    const pass = await this.prisma.$transaction(async (tx) => {
      let visitor = await tx.visitor.findFirst({
        where: {
          societyId: dto.societyId,
          name: finalVisitorName,
          phone,
          category: dto.category as VisitorCategory,
        },
      });
      if (!visitor) {
        visitor = await tx.visitor.create({
          data: {
            societyId: dto.societyId,
            name: finalVisitorName,
            phone,
            category: dto.category as VisitorCategory,
          },
        });
      }

      const created = await tx.visitorPass.create({
        data: {
          societyId: dto.societyId,
          flatId: dto.flatId,
          hostUserId,
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
            create: accessPoints.map((ap) => ({ accessPointId: ap.id })),
          },
        },
        include: {
          visitor: { select: { id: true, name: true, phone: true } },
        },
      });

      // Enqueue notification for the resident
      await tx.notification.create({
        data: {
          societyId: dto.societyId,
          userId: hostUserId,
          channel: 'PUSH',
          template: 'VISITOR_SELF_REGISTERED',
          status: 'PENDING',
          payload: {
            event: 'VISITOR_SELF_REGISTERED',
            passId: created.id,
            visitorName: trimmedName,
            vehicle: trimmedVehicle,
            category: dto.category,
            requiresApproval,
            destination: `${flat.building.name} · ${flat.flatNumber}`,
          },
          nextAttemptAt: new Date(),
        },
      }).catch(() => undefined);

      return created;
    });

    return {
      passId: pass.id,
      societyId: dto.societyId,
      status: pass.status as 'ACTIVE' | 'PENDING_APPROVAL',
      category: pass.category,
      visitor: pass.visitor,
      flat: {
        id: flat.id,
        buildingName: flat.building.name,
        flatNumber: flat.flatNumber,
      },
      validFrom: pass.validFrom.toISOString(),
      validUntil: pass.validUntil.toISOString(),
      maxUses: pass.maxUses,
      credentials: {
        pin: pin.plaintext,
        qrToken: qr.plaintext,
      },
      accessPoints,
      requiresHostApproval: requiresApproval,
      message: requiresApproval
        ? 'Pass registered and pending resident approval. You will receive entry access once approved.'
        : 'Pass successfully issued! Use your 6-digit PIN or scan the QR token at any gate.',
    };
  }
}
