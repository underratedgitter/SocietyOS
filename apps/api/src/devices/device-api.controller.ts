import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
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
}
