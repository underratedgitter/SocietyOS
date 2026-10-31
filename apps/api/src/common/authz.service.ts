import { Injectable } from '@nestjs/common';
import { Building, Device, Flat, MembershipRole, SocietyMembership } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { AppException } from './app.exception';

export interface SocietyContext {
  societyId: string;
  role: MembershipRole;
}

export interface FlatContext extends SocietyContext {
  flat: Flat & { building: Building };
  membership: SocietyMembership;
}

export interface BuildingContext extends SocietyContext {
  building: Building;
  membership: SocietyMembership;
}

export interface DeviceContext extends SocietyContext {
  device: Device;
  membership: SocietyMembership;
}

/**
 * Every tenant-scoped service uses this class rather than trusting a route
 * parameter or client-supplied society/role. Guards call the same checks so
 * controller wiring cannot drift from service authorization.
 */
@Injectable()
export class AuthzService {
  constructor(private readonly prisma: PrismaService) {}

  async society(
    userId: string,
    societyId: string,
    roles?: MembershipRole[],
  ): Promise<SocietyContext> {
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw AppException.forbidden('NOT_A_MEMBER', 'You are not an active member of this society');
    }
    this.checkRole(membership.role, roles);
    return { societyId, role: membership.role };
  }

  async societyMembership(userId: string, societyId: string): Promise<SocietyMembership> {
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw AppException.forbidden('NOT_A_MEMBER', 'You are not an active member of this society');
    }
    return membership;
  }

  async flat(userId: string, flatId: string, roles?: MembershipRole[]): Promise<FlatContext> {
    const flat = await this.prisma.flat.findUnique({
      where: { id: flatId },
      include: { building: true },
    });
    if (!flat) throw AppException.notFound('FLAT_NOT_FOUND', 'Flat not found');
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId: flat.building.societyId, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw AppException.forbidden('NOT_A_MEMBER', 'You are not an active member of this society');
    }
    this.checkRole(membership.role, roles);
    if (membership.role === 'RESIDENT') {
      const link = await this.prisma.residentFlatMembership.findFirst({
        where: { flatId, userId, endedAt: null },
      });
      if (!link) {
        throw AppException.forbidden('NOT_YOUR_FLAT', 'You are not a resident of this flat');
      }
    }
    return { flat, societyId: flat.building.societyId, role: membership.role, membership };
  }

  async building(
    userId: string,
    buildingId: string,
    roles?: MembershipRole[],
  ): Promise<BuildingContext> {
    const building = await this.prisma.building.findUnique({ where: { id: buildingId } });
    if (!building) throw AppException.notFound('BUILDING_NOT_FOUND', 'Building not found');
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId: building.societyId, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw AppException.forbidden('NOT_A_MEMBER', 'You are not an active member of this society');
    }
    this.checkRole(membership.role, roles);
    return { building, societyId: building.societyId, role: membership.role, membership };
  }

  async device(userId: string, deviceId: string, roles?: MembershipRole[]): Promise<DeviceContext> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw AppException.notFound('DEVICE_NOT_FOUND', 'Device not found');
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId: device.societyId, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw AppException.forbidden('NOT_A_MEMBER', 'You are not an active member of this society');
    }
    this.checkRole(membership.role, roles);
    return { device, societyId: device.societyId, role: membership.role, membership };
  }

  async assertResidentOfFlat(userId: string, flatId: string): Promise<void> {
    const link = await this.prisma.residentFlatMembership.findFirst({
      where: { flatId, userId, endedAt: null },
    });
    if (!link) throw AppException.forbidden('NOT_YOUR_FLAT', 'You are not a resident of this flat');
  }

  private checkRole(role: MembershipRole, roles?: MembershipRole[]): void {
    if (roles && !roles.includes(role)) {
      throw AppException.forbidden('FORBIDDEN_ROLE', 'Your role cannot perform this action');
    }
  }
}
