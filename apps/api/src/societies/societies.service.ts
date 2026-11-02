import { Injectable } from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AuthzService } from '../common/authz.service';
import { AuthService } from '../auth/auth.service';
import { JwtUser } from '../auth/jwt-auth.guard';
import { AuditService } from '../common/audit.service';
import { AppException } from '../common/app.exception';
import { mergeVisitorPolicy, visitorPolicy } from './policy';
import {
  AddFlatMemberDto,
  CreateBuildingDto,
  CreateFlatDto,
  CreateGuardDto,
  CreateSocietyDto,
  InviteResidentDto,
  UpdateSocietyDto,
} from './societies.dto';

@Injectable()
export class SocietiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async createSociety(caller: JwtUser, dto: CreateSocietyDto) {
    if (!caller.isPlatformAdmin) {
      throw AppException.forbidden('PLATFORM_ADMIN_REQUIRED', 'Only platform administrators can onboard societies');
    }
    this.assertTimezone(dto.timezone || 'Asia/Kolkata');
    const adminEmail = dto.adminEmail.toLowerCase().trim();

    const result = await this.prisma.$transaction(async (tx) => {
      const slugTaken = await tx.society.findUnique({ where: { slug: dto.slug } });
      if (slugTaken) throw AppException.conflict('SLUG_TAKEN', 'A society with this slug already exists');
      const userTaken = await tx.user.findUnique({ where: { email: adminEmail } });
      if (userTaken) {
        throw AppException.conflict(
          'EMAIL_IN_USE',
          'This email already belongs to an account. Use a new address for the society administrator.',
        );
      }
      const created = await this.auth.createUserWithTemporaryPassword(
        { name: dto.adminName, email: adminEmail },
        tx,
      );
      const society = await tx.society.create({
        data: {
          name: dto.name.trim(),
          slug: dto.slug,
          timezone: dto.timezone || 'Asia/Kolkata',
          memberships: {
            create: {
              userId: created.user.id,
              role: MembershipRole.SOCIETY_ADMIN,
              status: 'ACTIVE',
            },
          },
        },
        select: { id: true, name: true, slug: true, timezone: true, createdAt: true },
      });
      await tx.auditLog.create({
        data: {
          societyId: society.id,
          actorUserId: caller.sub,
          actorRole: 'PLATFORM_ADMIN',
          action: 'SOCIETY_CREATED',
          entityType: 'Society',
          entityId: society.id,
          meta: { name: society.name, slug: society.slug, adminEmail },
        },
      });
      return { society, admin: { id: created.user.id, name: created.user.name, email: adminEmail, temporaryPassword: created.temporaryPassword } };
    });

    return result;
  }

  async listMine(userId: string, isPlatformAdmin: boolean) {
    const memberships = await this.prisma.societyMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: {
        society: {
          select: {
            id: true,
            name: true,
            slug: true,
            timezone: true,
            settings: true,
            createdAt: true,
            _count: { select: { buildings: true, accessPoints: true, devices: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const result = memberships.map((membership) => ({
      ...membership.society,
      role: membership.role,
      policy: visitorPolicy(membership.society.settings),
    }));
    if (isPlatformAdmin) {
      const memberIds = new Set(result.map((society) => society.id));
      const all = await this.prisma.society.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          createdAt: true,
          _count: { select: { buildings: true, accessPoints: true, devices: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      for (const society of all) {
        if (memberIds.has(society.id)) continue;
        result.push({
          ...society,
          settings: {},
          _count: society._count,
          role: 'PLATFORM_ADMIN' as never,
          policy: visitorPolicy(null),
        });
      }
    }
    return result;
  }

  async getSociety(societyId: string) {
    const society = await this.prisma.society.findUnique({
      where: { id: societyId },
      include: {
        _count: {
          select: {
            buildings: true,
            accessPoints: true,
            devices: true,
            memberships: true,
            passes: true,
          },
        },
      },
    });
    if (!society) throw AppException.notFound('SOCIETY_NOT_FOUND', 'Society not found');
    return { ...society, policy: visitorPolicy(society.settings) };
  }

  async updateSociety(caller: JwtUser, actorRole: string, societyId: string, dto: UpdateSocietyDto) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN']);
    const existing = await this.prisma.society.findUnique({ where: { id: societyId } });
    if (!existing) throw AppException.notFound('SOCIETY_NOT_FOUND');
    if (dto.timezone) this.assertTimezone(dto.timezone);

    const rawSettings =
      existing.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings)
        ? (existing.settings as Record<string, unknown>)
        : {};
    // A partial update preserves omitted fields; DTO instances carry
    // declared-but-unset properties as undefined, so a plain spread would reset them.
    const nextPolicy = dto.policy ? mergeVisitorPolicy(rawSettings, dto.policy) : undefined;
    const updated = await this.prisma.society.update({
      where: { id: societyId },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        ...(nextPolicy ? { settings: { ...rawSettings, ...nextPolicy } as Prisma.InputJsonValue } : {}),
      },
    });
    await this.audit.record({
      societyId,
      actorUserId: caller.sub,
      actorRole,
      action: 'SOCIETY_UPDATED',
      entityType: 'Society',
      entityId: societyId,
      meta: { fields: Object.keys(dto) },
    });
    return { ...updated, policy: visitorPolicy(updated.settings) };
  }

  async createBuilding(caller: JwtUser, actorRole: string, societyId: string, dto: CreateBuildingDto) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN']);
    const building = await this.prisma.building.create({
      data: { societyId, name: dto.name.trim() },
    });
    await this.audit.record({
      societyId,
      actorUserId: caller.sub,
      actorRole,
      action: 'BUILDING_CREATED',
      entityType: 'Building',
      entityId: building.id,
      meta: { name: building.name },
    });
    return building;
  }

  async listBuildings(societyId: string) {
    const buildings = await this.prisma.building.findMany({
      where: { societyId },
      include: {
        flats: {
          include: { residents: { where: { endedAt: null }, select: { userId: true } } },
          orderBy: { flatNumber: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return buildings.map((building) => ({
      id: building.id,
      name: building.name,
      flats: building.flats.map((flat) => ({
        id: flat.id,
        flatNumber: flat.flatNumber,
        residentCount: flat.residents.length,
      })),
    }));
  }

  async createFlat(caller: JwtUser, buildingId: string, dto: CreateFlatDto) {
    const context = await this.authz.building(caller.sub, buildingId, ['SOCIETY_ADMIN']);
    const flatNumber = dto.flatNumber.trim();
    const duplicate = await this.prisma.flat.findUnique({
      where: { buildingId_flatNumber: { buildingId, flatNumber } },
    });
    if (duplicate) throw AppException.conflict('FLAT_EXISTS', 'Flat number already exists in this building');
    const flat = await this.prisma.flat.create({ data: { buildingId, flatNumber } });
    await this.audit.record({
      societyId: context.societyId,
      actorUserId: caller.sub,
      actorRole: context.role,
      action: 'FLAT_CREATED',
      entityType: 'Flat',
      entityId: flat.id,
      meta: { flatNumber, buildingId },
    });
    return flat;
  }

  async listFlats(userId: string, societyId: string) {
    const context = await this.authz.society(userId, societyId);
    const where: Prisma.FlatWhereInput = { building: { societyId } };
    if (context.role === 'RESIDENT') {
      where.residents = { some: { userId, endedAt: null } };
    }
    const flats = await this.prisma.flat.findMany({
      where,
      include: {
        building: { select: { id: true, name: true } },
        residents: {
          where: { endedAt: null },
          include: {
            user: {
              select:
                context.role === 'SOCIETY_ADMIN'
                  ? { id: true, name: true, email: true, phone: true }
                  : { id: true, name: true },
            },
          },
        },
      },
      orderBy: [{ building: { name: 'asc' } }, { flatNumber: 'asc' }],
    });
    return flats.map((flat) => ({
      id: flat.id,
      flatNumber: flat.flatNumber,
      building: flat.building,
      residents: flat.residents.map((link) => ({
        userId: link.user.id,
        name: link.user.name,
        email: 'email' in link.user ? link.user.email : undefined,
        phone: 'phone' in link.user ? link.user.phone : undefined,
        relationship: link.relationship,
      })),
    }));
  }

  async inviteResident(caller: JwtUser, actorRole: string, societyId: string, dto: InviteResidentDto) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN']);
    const flat = await this.prisma.flat.findFirst({
      where: { id: dto.flatId, building: { societyId } },
      select: { id: true },
    });
    if (!flat) throw AppException.unprocessable('FLAT_NOT_IN_SOCIETY', 'The given flat does not belong to this society');
    return this.linkResident({
      actor: caller,
      actorRole,
      societyId,
      flatId: flat.id,
      dto,
      allowOwnerTenant: true,
    });
  }

  async addFlatMember(caller: JwtUser, flatId: string, dto: AddFlatMemberDto) {
    const context = await this.authz.flat(caller.sub, flatId);
    if (context.role !== 'SOCIETY_ADMIN' && context.role !== 'RESIDENT') {
      throw AppException.forbidden('FORBIDDEN_ROLE', 'Only administrators and residents can add household members');
    }
    if (context.role === 'RESIDENT' && dto.relationship !== 'FAMILY') {
      throw AppException.forbidden('RELATIONSHIP_NOT_ALLOWED', 'Residents can only add family members');
    }
    return this.linkResident({
      actor: caller,
      actorRole: context.role,
      societyId: context.societyId,
      flatId,
      dto,
      allowOwnerTenant: context.role === 'SOCIETY_ADMIN',
    });
  }

  async removeFlatMember(caller: JwtUser, flatId: string, userId: string) {
    const context = await this.authz.flat(caller.sub, flatId, ['SOCIETY_ADMIN']);
    const link = await this.prisma.residentFlatMembership.findUnique({
      where: { flatId_userId: { flatId, userId } },
    });
    if (!link || link.endedAt) throw AppException.notFound('MEMBERSHIP_NOT_FOUND', 'Active flat membership not found');

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.residentFlatMembership.update({
        where: { id: link.id },
        data: { endedAt: new Date() },
      });
      const remaining = await tx.residentFlatMembership.count({
        where: {
          userId,
          endedAt: null,
          flat: { building: { societyId: context.societyId } },
        },
      });
      if (remaining === 0) {
        await tx.societyMembership.updateMany({
          where: { societyId: context.societyId, userId, role: 'RESIDENT' },
          data: { status: 'DISABLED' },
        });
      }
      const revoked = await tx.visitorPass.updateMany({
        where: {
          societyId: context.societyId,
          flatId,
          hostUserId: userId,
          status: { in: ['ACTIVE', 'PENDING_APPROVAL'] },
        },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: caller.sub },
      });
      await tx.auditLog.create({
        data: {
          societyId: context.societyId,
          actorUserId: caller.sub,
          actorRole: context.role,
          action: 'FLAT_MEMBERSHIP_ENDED',
          entityType: 'ResidentFlatMembership',
          entityId: link.id,
          meta: { flatId, userId, revokedPasses: revoked.count },
        },
      });
      return { revokedPasses: revoked.count };
    });
    return { ok: true, ...result };
  }

  async household(userId: string, flatId: string) {
    await this.authz.flat(userId, flatId);
    const links = await this.prisma.residentFlatMembership.findMany({
      where: { flatId, endedAt: null },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return links.map((link) => ({
      userId: link.user.id,
      name: link.user.name,
      relationship: link.relationship,
      joinedAt: link.createdAt,
      isSelf: link.user.id === userId,
    }));
  }

  async listResidents(userId: string, societyId: string) {
    const context = await this.authz.society(userId, societyId, ['SOCIETY_ADMIN', 'GUARD']);
    const memberships = await this.prisma.societyMembership.findMany({
      where: { societyId, role: 'RESIDENT', ...(context.role === 'GUARD' ? { status: 'ACTIVE' } : {}) },
      include: {
        user: {
          include: {
            flatMemberships: {
              where: { endedAt: null, flat: { building: { societyId } } },
              include: { flat: { include: { building: { select: { id: true, name: true } } } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((membership) => ({
      userId: membership.user.id,
      name: membership.user.name,
      email: context.role === 'SOCIETY_ADMIN' ? membership.user.email : undefined,
      phone: context.role === 'SOCIETY_ADMIN' ? membership.user.phone : undefined,
      status: membership.status,
      flats: membership.user.flatMemberships.map((link) => ({
        id: link.flat.id,
        flatNumber: link.flat.flatNumber,
        building: link.flat.building.name,
        relationship: link.relationship,
      })),
    }));
  }

  async listStaff(userId: string, societyId: string) {
    const context = await this.authz.society(userId, societyId, ['SOCIETY_ADMIN', 'GUARD']);
    const staff = await this.prisma.societyMembership.findMany({
      where: { societyId, role: { in: ['SOCIETY_ADMIN', 'GUARD'] } },
      include: { user: { select: { id: true, name: true, email: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return staff.map((membership) => ({
      userId: membership.user.id,
      name: membership.user.name,
      email: context.role === 'SOCIETY_ADMIN' ? membership.user.email : undefined,
      phone: context.role === 'SOCIETY_ADMIN' ? membership.user.phone : undefined,
      role: membership.role,
      status: membership.status,
      createdAt: membership.createdAt,
    }));
  }

  async createGuard(caller: JwtUser, actorRole: string, societyId: string, dto: CreateGuardDto) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN']);
    const email = dto.email.toLowerCase().trim();
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await this.auth.createUserWithTemporaryPassword(
        { name: dto.name, email, phone: dto.phone },
        tx,
      );
      await tx.societyMembership.create({
        data: {
          societyId,
          userId: created.user.id,
          role: MembershipRole.GUARD,
          status: 'ACTIVE',
        },
      });
      await tx.auditLog.create({
        data: {
          societyId,
          actorUserId: caller.sub,
          actorRole,
          action: 'GUARD_CREATED',
          entityType: 'User',
          entityId: created.user.id,
          meta: { email },
        },
      });
      return {
        user: { id: created.user.id, name: created.user.name, email },
        temporaryPassword: created.temporaryPassword,
      };
    });
    return result;
  }

  async overview(userId: string, societyId: string) {
    const context = await this.authz.society(userId, societyId, ['SOCIETY_ADMIN', 'GUARD']);
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const onlineSince = new Date(now.getTime() - 2 * 60 * 1000);
    const [
      buildings,
      flats,
      residents,
      activePasses,
      pendingPasses,
      devices,
      onlineDevices,
      alerts,
      allowedToday,
      deniedToday,
      recentEvents,
      society,
    ] = await Promise.all([
      this.prisma.building.count({ where: { societyId } }),
      this.prisma.flat.count({ where: { building: { societyId } } }),
      this.prisma.societyMembership.count({ where: { societyId, role: 'RESIDENT', status: 'ACTIVE' } }),
      this.prisma.visitorPass.count({
        where: {
          societyId,
          status: 'ACTIVE',
          validFrom: { lte: now },
          validUntil: { gte: now },
        },
      }),
      this.prisma.visitorPass.count({ where: { societyId, status: 'PENDING_APPROVAL' } }),
      this.prisma.device.count({ where: { societyId } }),
      this.prisma.device.count({ where: { societyId, status: 'ACTIVE', lastSeenAt: { gte: onlineSince } } }),
      this.prisma.securityAlert.count({ where: { societyId, resolvedAt: null } }),
      this.prisma.accessEvent.count({ where: { societyId, decision: 'AUTHORIZED', requestedAt: { gte: since } } }),
      this.prisma.accessEvent.count({ where: { societyId, decision: 'DENIED', requestedAt: { gte: since } } }),
      this.prisma.accessEvent.findMany({
        where: { societyId },
        include: {
          accessPoint: { select: { id: true, name: true } },
          pass: { select: { id: true, visitor: { select: { name: true } }, flat: { select: { flatNumber: true } } } },
        },
        orderBy: { requestedAt: 'desc' },
        take: 8,
      }),
      this.prisma.society.findUnique({ where: { id: societyId }, select: { settings: true, timezone: true } }),
    ]);
    return {
      counts: {
        buildings,
        flats,
        residents,
        activePasses,
        pendingPasses,
        devices,
        onlineDevices,
        openAlerts: alerts,
        allowedToday,
        deniedToday,
      },
      recentEvents,
      policy: visitorPolicy(society?.settings),
      timezone: society?.timezone,
      role: context.role,
    };
  }

  async auditLogs(societyId: string) {
    return this.prisma.auditLog.findMany({
      where: { societyId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async securityAlerts(societyId: string) {
    return this.prisma.securityAlert.findMany({
      where: { societyId, resolvedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  private async linkResident(input: {
    actor: JwtUser;
    actorRole: string;
    societyId: string;
    flatId: string;
    dto: InviteResidentDto | AddFlatMemberDto;
    allowOwnerTenant: boolean;
  }) {
    if (!input.allowOwnerTenant && input.dto.relationship !== 'FAMILY') {
      throw AppException.forbidden('RELATIONSHIP_NOT_ALLOWED', 'Residents can only add family members');
    }
    const email = input.dto.email.toLowerCase().trim();
    return this.prisma.$transaction(async (tx) => {
      const created = await this.auth.findOrCreateUserWithTemporaryPassword(
        { name: input.dto.name, email, phone: input.dto.phone },
        tx,
      );
      if (created.user.isPlatformAdmin) {
        throw AppException.conflict('ROLE_CONFLICT', 'A platform administrator cannot be added as a resident');
      }
      const membership = await tx.societyMembership.findUnique({
        where: { societyId_userId: { societyId: input.societyId, userId: created.user.id } },
      });
      if (membership && membership.role !== 'RESIDENT') {
        throw AppException.conflict('ROLE_CONFLICT', 'This user already has a staff role in this society');
      }
      if (!membership) {
        await tx.societyMembership.create({
          data: {
            societyId: input.societyId,
            userId: created.user.id,
            role: 'RESIDENT',
            status: 'ACTIVE',
          },
        });
      } else if (membership.status !== 'ACTIVE') {
        await tx.societyMembership.update({
          where: { id: membership.id },
          data: { status: 'ACTIVE' },
        });
      }

      const existingLink = await tx.residentFlatMembership.findUnique({
        where: { flatId_userId: { flatId: input.flatId, userId: created.user.id } },
      });
      if (existingLink && !existingLink.endedAt) {
        throw AppException.conflict('ALREADY_A_RESIDENT', 'User is already an active resident of this flat');
      }
      if (existingLink) {
        await tx.residentFlatMembership.update({
          where: { id: existingLink.id },
          data: { endedAt: null, relationship: input.dto.relationship },
        });
      } else {
        await tx.residentFlatMembership.create({
          data: {
            flatId: input.flatId,
            userId: created.user.id,
            relationship: input.dto.relationship,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          societyId: input.societyId,
          actorUserId: input.actor.sub,
          actorRole: input.actorRole,
          action: 'RESIDENT_LINKED',
          entityType: 'ResidentFlatMembership',
          entityId: `${input.flatId}:${created.user.id}`,
          meta: { flatId: input.flatId, userId: created.user.id, relationship: input.dto.relationship },
        },
      });

      return {
        user: { id: created.user.id, name: created.user.name, email: created.user.email },
        flatId: input.flatId,
        relationship: input.dto.relationship,
        temporaryPassword: created.temporaryPassword,
      };
    });
  }

  private assertTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw AppException.unprocessable('INVALID_TIMEZONE', 'timezone must be a valid IANA timezone');
    }
  }
}
