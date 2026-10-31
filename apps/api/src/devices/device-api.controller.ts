import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DeviceAuthGuard } from './device-auth.guard';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';

const DEVICE_EVENT_TYPES = [
  'COMMAND_RECEIVED',
  'ACK',
  'STATE_CHANGED',
  'SENSOR',
  'HEARTBEAT',
  'TAMPER',
  'FAULT',
] as const;

export class QueuedOfflineEventDto {
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsUUID()
  accessPointId!: string;

  @IsString()
  credentialType!: string;

  @IsIn(['AUTHORIZED', 'DENIED'])
  decision!: 'AUTHORIZED' | 'DENIED';

  @IsString()
  reasonCode!: string;

  @IsString()
  timestamp!: string;
}

export class SyncOfflineEventsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QueuedOfflineEventDto)
  events!: QueuedOfflineEventDto[];
}


export class DeviceHealthDto {
  @IsBoolean()
  online!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  uptimeS?: number;

  @IsOptional()
  @IsInt()
  @Min(-150)
  @Max(0)
  rssi?: number;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}

export class DeviceEventDto {
  @IsIn(DEVICE_EVENT_TYPES)
  type!: (typeof DEVICE_EVENT_TYPES)[number];

  @IsOptional()
  @IsUUID()
  accessPointId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sequence?: number;

  @IsObject()
  payload!: Record<string, unknown>;
}

@ApiTags('device-api')
@Controller('device-api')
@UseGuards(DeviceAuthGuard)
export class DeviceApiController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  me(@Req() req: AuthedRequest) {
    return this.prisma.device.findUnique({
      where: { id: req.device!.id },
      select: {
        id: true,
        deviceUid: true,
        name: true,
        societyId: true,
        status: true,
        firmware: true,
        lastSeenAt: true,
        accessPoints: {
          include: { accessPoint: { select: { id: true, name: true, type: true, location: true } } },
        },
      },
    });
  }

  @Post('health')
  async health(@Req() req: AuthedRequest, @Body() dto: DeviceHealthDto) {
    const payloadSize = JSON.stringify(dto.meta ?? {}).length;
    if (payloadSize > 4096) throw AppException.unprocessable('PAYLOAD_TOO_LARGE', 'Health metadata is too large');
    await this.prisma.$transaction([
      this.prisma.deviceHealthLog.create({
        data: {
          deviceId: req.device!.id,
          online: dto.online,
          uptimeS: dto.uptimeS,
          rssi: dto.rssi,
          meta: (dto.meta ?? {}) as never,
        },
      }),
      this.prisma.device.update({
        where: { id: req.device!.id },
        data: { lastSeenAt: new Date() },
      }),
    ]);
    return { ok: true, serverTime: new Date().toISOString() };
  }

  @Post('events')
  async events(@Req() req: AuthedRequest, @Body() dto: DeviceEventDto) {
    if (JSON.stringify(dto.payload).length > 8192) {
      throw AppException.unprocessable('PAYLOAD_TOO_LARGE', 'Event payload is too large');
    }
    if (dto.accessPointId) {
      const link = await this.prisma.deviceAccessPoint.findUnique({
        where: {
          deviceId_accessPointId: {
            deviceId: req.device!.id,
            accessPointId: dto.accessPointId,
          },
        },
      });
      if (!link) throw AppException.forbidden('WRONG_ACCESS_POINT', 'Access point is not assigned to this device');
    }
    const event = await this.prisma.deviceEvent.create({
      data: {
        deviceId: req.device!.id,
        accessPointId: dto.accessPointId,
        type: dto.type,
        sequence: dto.sequence,
        payload: dto.payload as never,
      },
    });
    await this.prisma.device.update({
      where: { id: req.device!.id },
      data: { lastSeenAt: new Date() },
    });
    return { ok: true, eventId: event.id };
  }

  @Post('sync-offline')
  async syncOffline(@Req() req: AuthedRequest, @Body() dto: SyncOfflineEventsDto) {
    if (!dto.events || !Array.isArray(dto.events)) {
      throw AppException.badRequest('INVALID_PAYLOAD', 'events must be an array');
    }
    if (dto.events.length > 500) {
      throw AppException.unprocessable('BATCH_TOO_LARGE', 'Maximum 500 events per batch');
    }

    const deviceId = req.device!.id;
    const societyId = req.device!.societyId;

    const apIds = Array.from(new Set(dto.events.map((e) => e.accessPointId)));
    const validAps = await this.prisma.accessPoint.findMany({
      where: { id: { in: apIds }, societyId },
      select: { id: true },
    });
    const validApSet = new Set(validAps.map((ap) => ap.id));

    let syncedCount = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const ev of dto.events) {
        if (!validApSet.has(ev.accessPointId)) continue;
        const credType = (['PIN', 'QR'].includes(ev.credentialType) ? ev.credentialType : null) as any;
        const requestedAt = new Date(ev.timestamp);
        const validTime = !isNaN(requestedAt.getTime()) ? requestedAt : new Date();

        await tx.accessEvent.create({
          data: {
            societyId,
            accessPointId: ev.accessPointId,
            deviceId,
            decision: ev.decision,
            reasonCode: ev.reasonCode,
            source: 'OFFLINE_EDGE_CONTROLLER',
            credentialType: credType,
            requestedAt: validTime,
            meta: {
              offlineSequence: ev.sequence,
              rawCredentialType: ev.credentialType,
              resyncedAt: new Date().toISOString(),
            } as never,
          },
        });

        await tx.deviceEvent.create({
          data: {
            deviceId,
            accessPointId: ev.accessPointId,
            type: 'ACK',
            sequence: ev.sequence,
            payload: {
              offlineSequence: ev.sequence,
              decision: ev.decision,
              reasonCode: ev.reasonCode,
              source: 'OFFLINE_CONTROLLER_SYNC',
            } as never,
          },
        });
        syncedCount++;
      }

      await tx.device.update({
        where: { id: deviceId },
        data: { lastSeenAt: new Date() },
      });
    });

    return { ok: true, syncedCount, serverTime: new Date().toISOString() };
  }

  @Get('edge-sync')
  async edgeSync(@Req() req: AuthedRequest) {
    const deviceId = req.device!.id;
    const societyId = req.device!.societyId;

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        accessPoints: { select: { accessPointId: true } },
      },
    });

    const apIds = device?.accessPoints.map((ap) => ap.accessPointId) ?? [];
    const now = new Date();
    const boundedFuture = new Date(now.getTime() + 24 * 3600 * 1000);

    const passes = await this.prisma.visitorPass.findMany({
      where: {
        societyId,
        status: 'ACTIVE',
        validUntil: { gte: now },
        validFrom: { lte: boundedFuture },
        revokedAt: null,
        OR: [
          { accessPoints: { none: {} } },
          { accessPoints: { some: { accessPointId: { in: apIds } } } },
        ],
      },
      include: {
        visitor: { select: { name: true } },
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
        credentials: { select: { credentialHash: true, type: true } },
      },
    });

    const credentialsList = passes
      .filter((p) => p.usedCount < p.maxUses)
      .flatMap((p) =>
        p.credentials.map((c) => ({
          credentialHash: c.credentialHash,
          kind: c.type,
          visitorName: p.visitor.name,
          flatNumber: `${p.flat.building.name} · ${p.flat.flatNumber}`,
          validFrom: p.validFrom.getTime(),
          validUntil: p.validUntil.getTime(),
          maxUses: p.maxUses,
          usedCount: p.usedCount,
        })),
      );

    const residents = await this.prisma.residentFlatMembership.findMany({
      where: {
        flat: { building: { societyId } },
        endedAt: null,
      },
      include: {
        user: { select: { id: true, name: true } },
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
      },
    });

    const residentCredentials = residents.map((r) => ({
      credentialHash: `BIO_RESIDENT_${r.userId}`,
      kind: 'BIOMETRIC' as const,
      visitorName: `${r.user.name} (Resident)`,
      flatNumber: `${r.flat.building.name} · ${r.flat.flatNumber}`,
      validFrom: 0,
      validUntil: now.getTime() + 365 * 86400_000,
      maxUses: 999999,
      usedCount: 0,
    }));

    return {
      ok: true,
      serverTime: now.toISOString(),
      societyId,
      deviceId,
      assignedAccessPoints: apIds,
      policy: {
        offlineValidityWindowHours: 24,
        maxOfflineEvents: 500,
        syncIntervalSeconds: 300,
      },
      credentials: [...residentCredentials, ...credentialsList],
    };
  }
}

