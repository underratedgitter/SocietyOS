import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { AuditService } from '../common/audit.service';
import { AuthedRequest } from '../auth/jwt-auth.guard';

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createAccessPoint(req: AuthedRequest, dto: { name: string; type: string; location?: string }) {
    const societyId = req.membership!.societyId;
    const ap = await this.prisma.accessPoint.create({
      data: { societyId, name: dto.name, type: dto.type as never, location: dto.location },
    });
    await this.audit.record({
      societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership?.role,
      action: 'ACCESS_POINT_CREATED',
      entityType: 'AccessPoint',
      entityId: ap.id,
      meta: { name: ap.name, type: ap.type },
    });
    return ap;
  }

  listAccessPoints(societyId: string) {
    return this.prisma.accessPoint.findMany({
      where: { societyId },
      include: { devices: { include: { device: { select: { id: true, deviceUid: true, name: true, status: true, lastSeenAt: true } } } } },
      orderBy: { name: 'asc' },
    });
  }

  /** Provision a device; the device token is returned exactly once. */
  async provisionDevice(req: AuthedRequest, dto: { name: string; deviceUid: string; firmware?: string; accessPointIds: string[] }) {
    const societyId = req.membership!.societyId;
    const existing = await this.prisma.device.findUnique({ where: { deviceUid: dto.deviceUid } });
    if (existing) throw AppException.conflict('DEVICE_UID_TAKEN', 'deviceUid already provisioned');

    const aps = await this.prisma.accessPoint.findMany({ where: { id: { in: dto.accessPointIds }, societyId } });
    if (aps.length !== dto.accessPointIds.length || aps.length === 0) {
      throw AppException.unprocessable('ACCESS_POINT_NOT_IN_SOCIETY', 'Access points must exist in this society');
    }

    const token = `sos_dev_${randomBytes(24).toString('hex')}`;
    const device = await this.prisma.device.create({
      data: {
        societyId,
        deviceUid: dto.deviceUid,
        name: dto.name,
        firmware: dto.firmware,
        credentials: {
          create: { tokenHash: createHash('sha256').update(token).digest('hex'), keyId: 'v1' },
        },
        accessPoints: { create: aps.map((ap) => ({ accessPointId: ap.id })) },
      },
      include: { accessPoints: { include: { accessPoint: true } } },
    });
    await this.audit.record({
      societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership?.role,
      action: 'DEVICE_PROVISIONED',
      entityType: 'Device',
      entityId: device.id,
      meta: { deviceUid: device.deviceUid, accessPoints: aps.map((a) => a.id) },
    });
    return {
      device: {
        id: device.id,
        deviceUid: device.deviceUid,
        name: device.name,
        societyId: device.societyId,
        accessPoints: device.accessPoints.map((l) => ({
          id: l.accessPoint.id,
          name: l.accessPoint.name,
          type: l.accessPoint.type,
        })),
      },
      deviceToken: token, // shown once
    };
  }

  listDevices(societyId: string) {
    return this.prisma.device.findMany({
      where: { societyId },
      include: {
        accessPoints: { include: { accessPoint: { select: { id: true, name: true, type: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async deviceHealth(req: AuthedRequest, deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { healthLogs: { orderBy: { recordedAt: 'desc' }, take: 50 } },
    });
    if (!device) throw new NotFoundException('DEVICE_NOT_FOUND');
    if (req.membership?.societyId !== device.societyId) throw new ForbiddenException('NOT_A_MEMBER');
    return {
      device: {
        id: device.id,
        deviceUid: device.deviceUid,
        name: device.name,
        status: device.status,
        firmware: device.firmware,
        lastSeenAt: device.lastSeenAt,
      },
      healthLogs: device.healthLogs,
    };
  }

  async setDeviceStatus(req: AuthedRequest, deviceId: string, status: 'ACTIVE' | 'DISABLED') {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('DEVICE_NOT_FOUND');
    if (req.membership?.societyId !== device.societyId || req.membership.role !== 'SOCIETY_ADMIN') {
      throw new ForbiddenException('FORBIDDEN_ROLE');
    }
    const updated = await this.prisma.device.update({ where: { id: deviceId }, data: { status } });
    await this.audit.record({
      societyId: device.societyId,
      actorUserId: req.user!.sub,
      actorRole: req.membership.role,
      action: status === 'DISABLED' ? 'DEVICE_DISABLED' : 'DEVICE_ENABLED',
      entityType: 'Device',
      entityId: deviceId,
    });
    return updated;
  }

  async accessEvents(societyId: string, opts: { limit?: number; accessPointId?: string }) {
    return this.prisma.accessEvent.findMany({
      where: { societyId, ...(opts.accessPointId ? { accessPointId: opts.accessPointId } : {}) },
      include: {
        accessPoint: { select: { id: true, name: true } },
        pass: { include: { visitor: { select: { name: true } }, flat: { select: { flatNumber: true } } } },
      },
      orderBy: { requestedAt: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }

  async gateCommands(societyId: string, opts: { limit?: number }) {
    return this.prisma.gateCommand.findMany({
      where: { device: { societyId } },
      include: {
        device: { select: { id: true, deviceUid: true, name: true } },
        accessPoint: { select: { id: true, name: true } },
      },
      orderBy: { issuedAt: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }
}
