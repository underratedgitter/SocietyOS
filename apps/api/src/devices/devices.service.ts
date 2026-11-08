import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AuthzService } from '../common/authz.service';
import { AppException } from '../common/app.exception';
import { AuditService } from '../common/audit.service';
import { JwtUser } from '../auth/jwt-auth.guard';
import { encryptDeviceSecret, sha256 } from '../common/crypto.util';
import { CreateAccessPointDto, ProvisionDeviceDto } from './devices.dto';

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  async createAccessPoint(caller: JwtUser, actorRole: string, societyId: string, dto: CreateAccessPointDto) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN']);
    const accessPoint = await this.prisma.accessPoint.create({
      data: {
        societyId,
        name: dto.name.trim(),
        type: dto.type,
        location: dto.location?.trim() || null,
      },
    });
    await this.audit.record({
      societyId,
      actorUserId: caller.sub,
      actorRole,
      action: 'ACCESS_POINT_CREATED',
      entityType: 'AccessPoint',
      entityId: accessPoint.id,
      meta: { name: accessPoint.name, type: accessPoint.type },
    });
    return accessPoint;
  }

  async listAccessPoints(caller: JwtUser, societyId: string) {
    const context = await this.authz.society(caller.sub, societyId);
    const includeDevices = context.role === 'SOCIETY_ADMIN' || context.role === 'GUARD';
    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { societyId },
      include: {
        devices: {
          include: {
            device: {
              select: { id: true, deviceUid: true, name: true, status: true, lastSeenAt: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    return accessPoints.map((accessPoint) => ({
      id: accessPoint.id,
      name: accessPoint.name,
      type: accessPoint.type,
      location: accessPoint.location,
      ...(includeDevices ? { devices: accessPoint.devices.map((link) => link.device) } : {}),
    }));
  }

  async provisionDevice(caller: JwtUser, actorRole: string, societyId: string, dto: ProvisionDeviceDto) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN']);
    if (dto.protocol === 'ZKTECO_ADMS' && !dto.pushAllowedIps?.length) {
      throw AppException.unprocessable(
        'PUSH_ALLOWED_IPS_REQUIRED',
        'ZKTeco ADMS cannot authenticate requests; set the site\'s static public IP in pushAllowedIps',
      );
    }
    const deviceUid = dto.deviceUid.trim();
    const existing = await this.prisma.device.findUnique({ where: { deviceUid } });
    if (existing) throw AppException.conflict('DEVICE_UID_TAKEN', 'This device UID is already provisioned');

    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { id: { in: dto.accessPointIds }, societyId },
      select: { id: true },
    });
    if (accessPoints.length !== dto.accessPointIds.length || accessPoints.length === 0) {
      throw AppException.unprocessable('ACCESS_POINT_NOT_IN_SOCIETY', 'Every access point must belong to this society');
    }

    const deviceToken = `sos_dev_${randomBytes(32).toString('base64url')}`;
    const commandSecret = randomBytes(32).toString('base64url');
    const device = await this.prisma.$transaction(async (tx) => {
      const created = await tx.device.create({
        data: {
          societyId,
          deviceUid,
          name: dto.name.trim(),
          firmware: dto.firmware?.trim() || null,
          protocol: dto.protocol ?? 'NATIVE',
          pushAllowedIps: dto.pushAllowedIps ?? [],
          credentials: {
            create: {
              tokenHash: sha256(deviceToken),
              commandSecretEnc: encryptDeviceSecret(commandSecret),
              keyId: 'v1',
            },
          },
          accessPoints: {
            create: accessPoints.map((accessPoint) => ({ accessPointId: accessPoint.id })),
          },
        },
        include: {
          accessPoints: {
            include: { accessPoint: { select: { id: true, name: true, type: true } } },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          societyId,
          actorUserId: caller.sub,
          actorRole,
          action: 'DEVICE_PROVISIONED',
          entityType: 'Device',
          entityId: created.id,
          meta: { deviceUid, accessPoints: accessPoints.map((accessPoint) => accessPoint.id) },
        },
      });
      return created;
    });

    return {
      device: this.deviceSummary(device),
      credentials: {
        deviceToken,
        commandSecret,
        note: 'These secrets are shown once. Store them on the device; never commit them.',
      },
    };
  }

  async rotateDeviceCredential(caller: JwtUser, deviceId: string) {
    const context = await this.authz.device(caller.sub, deviceId, ['SOCIETY_ADMIN']);
    const deviceToken = `sos_dev_${randomBytes(32).toString('base64url')}`;
    const commandSecret = randomBytes(32).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      await tx.deviceCredential.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.deviceCredential.create({
        data: {
          deviceId,
          tokenHash: sha256(deviceToken),
          commandSecretEnc: encryptDeviceSecret(commandSecret),
          keyId: 'v1',
        },
      });
      await tx.gateCommand.updateMany({
        where: { deviceId, status: { in: ['ISSUED', 'ACKNOWLEDGED'] } },
        data: { status: 'EXPIRED' },
      });
      await tx.auditLog.create({
        data: {
          societyId: context.societyId,
          actorUserId: caller.sub,
          actorRole: context.role,
          action: 'DEVICE_CREDENTIAL_ROTATED',
          entityType: 'Device',
          entityId: deviceId,
        },
      });
    });
    return {
      credentials: {
        deviceToken,
        commandSecret,
        note: 'The previous credential was revoked immediately. Secrets are shown once.',
      },
    };
  }

  async listDevices(caller: JwtUser, societyId: string) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN', 'GUARD']);
    const devices = await this.prisma.device.findMany({
      where: { societyId },
      include: {
        accessPoints: {
          include: { accessPoint: { select: { id: true, name: true, type: true } } },
        },
        healthLogs: { orderBy: { recordedAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    return devices.map((device) => ({
      ...this.deviceSummary(device),
      latestHealth: device.healthLogs[0] ?? null,
    }));
  }

  async deviceHealth(caller: JwtUser, deviceId: string) {
    const context = await this.authz.device(caller.sub, deviceId, ['SOCIETY_ADMIN', 'GUARD']);
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        accessPoints: { include: { accessPoint: { select: { id: true, name: true, type: true } } } },
        healthLogs: { orderBy: { recordedAt: 'desc' }, take: 50 },
      },
    });
    if (!device) throw AppException.notFound('DEVICE_NOT_FOUND', 'Device not found');
    return {
      device: this.deviceSummary(device),
      healthLogs: device.healthLogs,
      role: context.role,
    };
  }

  async setDeviceStatus(caller: JwtUser, deviceId: string, status: 'ACTIVE' | 'DISABLED') {
    const context = await this.authz.device(caller.sub, deviceId, ['SOCIETY_ADMIN']);
    const updated = await this.prisma.$transaction(async (tx) => {
      const device = await tx.device.update({ where: { id: deviceId }, data: { status } });
      if (status === 'DISABLED') {
        await tx.gateCommand.updateMany({
          where: { deviceId, status: { in: ['ISSUED', 'ACKNOWLEDGED'] } },
          data: { status: 'EXPIRED' },
        });
      }
      await tx.auditLog.create({
        data: {
          societyId: context.societyId,
          actorUserId: caller.sub,
          actorRole: context.role,
          action: status === 'DISABLED' ? 'DEVICE_DISABLED' : 'DEVICE_ENABLED',
          entityType: 'Device',
          entityId: deviceId,
        },
      });
      return device;
    });
    return this.deviceSummary(updated);
  }

  async accessEvents(
    caller: JwtUser,
    societyId: string,
    options: { limit?: number; accessPointId?: string },
  ) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN', 'GUARD']);
    const take = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return this.prisma.accessEvent.findMany({
      where: {
        societyId,
        ...(options.accessPointId ? { accessPointId: options.accessPointId } : {}),
      },
      include: {
        accessPoint: { select: { id: true, name: true } },
        pass: {
          include: {
            visitor: { select: { name: true } },
            flat: { select: { flatNumber: true } },
          },
        },
      },
      orderBy: { requestedAt: 'desc' },
      take,
    });
  }

  async gateCommands(caller: JwtUser, societyId: string, limit?: number) {
    await this.authz.society(caller.sub, societyId, ['SOCIETY_ADMIN', 'GUARD']);
    return this.prisma.gateCommand.findMany({
      where: { device: { societyId } },
      include: {
        device: { select: { id: true, deviceUid: true, name: true } },
        accessPoint: { select: { id: true, name: true } },
      },
      orderBy: { issuedAt: 'desc' },
      take: Math.min(Math.max(limit ?? 50, 1), 200),
    });
  }

  private deviceSummary(device: {
    id: string;
    deviceUid: string;
    name: string;
    societyId: string;
    status: string;
    firmware: string | null;
    lastSeenAt: Date | null;
    createdAt: Date;
    accessPoints?: { accessPoint: { id: string; name: string; type: string } }[];
  }) {
    return {
      id: device.id,
      deviceUid: device.deviceUid,
      name: device.name,
      societyId: device.societyId,
      status: device.status,
      firmware: device.firmware,
      lastSeenAt: device.lastSeenAt,
      createdAt: device.createdAt,
      accessPoints: device.accessPoints?.map((link) => link.accessPoint) ?? [],
    };
  }
}
