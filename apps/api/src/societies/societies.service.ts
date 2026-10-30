import { ForbiddenException, Injectable } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { AuditService } from '../common/audit.service';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class SocietiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Controlled society onboarding — platform administrators only. */
  async createSociety(
    caller: { sub: string; isPlatformAdmin: boolean },
    dto: { name: string; slug: string; timezone?: string; adminName: string; adminEmail: string; adminPassword: string },
  ) {
    if (!caller.isPlatformAdmin) {
      throw AppException.forbidden('PLATFORM_ADMIN_REQUIRED', 'Only platform administrators can onboard societies');
    }
    const exists = await this.prisma.society.findUnique({ where: { slug: dto.slug } });
    if (exists) throw AppException.conflict('SLUG_TAKEN', 'A society with this slug already exists');

    const adminEmail = dto.adminEmail.toLowerCase().trim();
    let admin = await this.prisma.user.findUnique({ where: { email: adminEmail } });
    if (!admin) {
      admin = await this.prisma.user.create({
        data: {
          name: dto.adminName,
          email: adminEmail,
          passwordHash: await bcrypt.hash(dto.adminPassword, 12),
        },
      });
    }

    const society = await this.prisma.society.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        timezone: dto.timezone || 'Asia/Kolkata',
        memberships: {
          create: { userId: admin.id, role: MembershipRole.SOCIETY_ADMIN, status: 'ACTIVE' },
        },
      },
    });
    await this.audit.record({
      actorUserId: caller.sub,
      actorRole: 'PLATFORM_ADMIN',
      action: 'SOCIETY_CREATED',
      entityType: 'Society',
      entityId: society.id,
      meta: { name: society.name, slug: society.slug, adminEmail },
    });
    return society;
  }

  async listMine(userId: string) {
    const memberships = await this.prisma.societyMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { society: true },
    });
    return memberships.map((m) => ({ ...m.society, role: m.role }));
  }

  async getSociety(societyId: string) {
    const society = await this.prisma.society.findUnique({
      where: { id: societyId },
      include: {
        _count: { select: { buildings: true, accessPoints: true, devices: true, memberships: true } },
      },
    });
    if (!society) throw AppException.notFound('SOCIETY_NOT_FOUND');
    return society;
  }

  async updateSociety(
    req: AuthedRequest,
    dto: { name?: string; timezone?: string },
  ) {
    const societyId = req.params.societyId;
    const updated = await this.prisma.society.update({
      where: { id: societyId },
      data: { ...(dto.name ? { name: dto.name } : {}), ...(dto.timezone ? { timezone: dto.timezone } : {}) },
    });
    await this.audit.record({
      societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership?.role,
      action: 'SOCIETY_UPDATED',
      entityType: 'Society',
      entityId: societyId,
      meta: dto,
    });
    return updated;
  }

  async createBuilding(req: AuthedRequest, dto: { name: string }) {
    const societyId = req.params.societyId;
    const building = await this.prisma.building.create({ data: { societyId, name: dto.name } });
    await this.audit.record({
      societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership?.role,
      action: 'BUILDING_CREATED',
      entityType: 'Building',
      entityId: building.id,
      meta: { name: building.name },
    });
    return building;
  }

  async listBuildings(societyId: string) {
    return this.prisma.building.findMany({
      where: { societyId },
      include: { flats: { orderBy: { flatNumber: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createFlat(req: AuthedRequest, buildingId: string, dto: { flatNumber: string }) {
    const building = await this.prisma.building.findUnique({ where: { id: buildingId } });
    if (!building) throw AppException.notFound('BUILDING_NOT_FOUND');
    this.assertSociety(req, building.societyId, ['SOCIETY_ADMIN']);
    const dup = await this.prisma.flat.findUnique({
      where: { buildingId_flatNumber: { buildingId, flatNumber: dto.flatNumber } },
    });
    if (dup) throw AppException.conflict('FLAT_EXISTS', 'Flat number already exists in this building');
    const flat = await this.prisma.flat.create({ data: { buildingId, flatNumber: dto.flatNumber } });
    await this.audit.record({
      societyId: building.societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership?.role,
      action: 'FLAT_CREATED',
      entityType: 'Flat',
      entityId: flat.id,
      meta: { flatNumber: flat.flatNumber, buildingId },
    });
    return flat;
  }

  async listFlats(societyId: string) {
    return this.prisma.flat.findMany({
      where: { building: { societyId } },
      include: {
        building: { select: { id: true, name: true } },
        residents: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
      orderBy: [{ building: { name: 'asc' } }, { flatNumber: 'asc' }],
    });
  }

  /** Admin invites/registers a resident into a flat of the society. */
  async inviteResident(req: AuthedRequest, dto: { name: string; email: string; password: string; phone?: string; flatId: string; relationship: string }) {
    const societyId = req.params.societyId;
    this.assertSociety(req, societyId, ['SOCIETY_ADMIN']);
    const flat = await this.prisma.flat.findFirst({
      where: { id: dto.flatId, building: { societyId } },
    });
    if (!flat) throw AppException.unprocessable('FLAT_NOT_IN_SOCIETY', 'The given flat does not belong to this society');
    return this.linkResidentToFlat(req, societyId, dto);
  }

  /** Resident (of the flat) or admin adds a household member. */
  async addFlatMember(req: AuthedRequest, flatId: string, dto: { name: string; email: string; password: string; phone?: string; relationship: string }) {
    const societyId = req.flat!.societyId;
    if (req.membership!.role === 'RESIDENT') {
      const link = await this.prisma.residentFlatMembership.findUnique({
        where: { flatId_userId: { flatId, userId: req.user!.sub } },
      });
      if (!link) throw AppException.forbidden('NOT_A_FLAT_RESIDENT');
    }
    return this.linkResidentToFlat(req, societyId, { ...dto, flatId });
  }

  async removeFlatMember(req: AuthedRequest, flatId: string, userId: string) {
    const societyId = req.flat!.societyId;
    if (req.membership!.role !== 'SOCIETY_ADMIN') {
      throw AppException.forbidden('FORBIDDEN_ROLE', 'Only society admins can end flat memberships');
    }
    const link = await this.prisma.residentFlatMembership.findUnique({
      where: { flatId_userId: { flatId, userId } },
    });
    if (!link) throw AppException.notFound('MEMBERSHIP_NOT_FOUND');
    await this.prisma.residentFlatMembership.delete({ where: { id: link.id } });
    await this.audit.record({
      societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership?.role,
      action: 'FLAT_MEMBERSHIP_ENDED',
      entityType: 'ResidentFlatMembership',
      entityId: link.id,
      meta: { flatId, userId },
    });
    return { ok: true };
  }

  async listResidents(societyId: string) {
    const memberships = await this.prisma.societyMembership.findMany({
      where: { societyId, role: 'RESIDENT' },
      include: {
        user: {
          include: {
            flatMemberships: { include: { flat: { include: { building: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      phone: m.user.phone,
      status: m.status,
      flats: m.user.flatMemberships
        .filter((f) => f.flat.building.societyId === societyId)
        .map((f) => ({ id: f.flat.id, flatNumber: f.flat.flatNumber, building: f.flat.building.name, relationship: f.relationship })),
    }));
  }

  private async linkResidentToFlat(
    req: AuthedRequest,
    societyId: string,
    dto: { name: string; email: string; password: string; phone?: string; flatId: string; relationship: string },
  ) {
    const email = dto.email.toLowerCase().trim();
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          name: dto.name,
          email,
          phone: dto.phone,
          passwordHash: await bcrypt.hash(dto.password, 12),
        },
      });
    }
    await this.prisma.societyMembership.upsert({
      where: { societyId_userId: { societyId, userId: user.id } },
      create: { societyId, userId: user.id, role: MembershipRole.RESIDENT, status: 'ACTIVE' },
      update: { status: 'ACTIVE' },
    });
    const existingLink = await this.prisma.residentFlatMembership.findUnique({
      where: { flatId_userId: { flatId: dto.flatId, userId: user.id } },
    });
    if (existingLink) throw AppException.conflict('ALREADY_A_RESIDENT', 'User is already linked to this flat');
    const link = await this.prisma.residentFlatMembership.create({
      data: { flatId: dto.flatId, userId: user.id, relationship: dto.relationship as never },
    });
    await this.audit.record({
      societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership?.role,
      action: 'RESIDENT_LINKED',
      entityType: 'ResidentFlatMembership',
      entityId: link.id,
      meta: { flatId: dto.flatId, userId: user.id, relationship: dto.relationship },
    });
    return { userId: user.id, flatId: dto.flatId, relationship: dto.relationship, name: user.name, email: user.email };
  }

  private assertSociety(req: AuthedRequest, societyId: string, roles: string[]) {
    if (req.membership?.societyId !== societyId) {
      throw new ForbiddenException('NOT_A_MEMBER');
    }
    if (!roles.includes(req.membership.role)) {
      throw AppException.forbidden('FORBIDDEN_ROLE', 'Your role cannot perform this action');
    }
  }
}
