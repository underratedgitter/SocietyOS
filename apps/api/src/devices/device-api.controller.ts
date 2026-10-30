import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { DeviceAuthGuard } from './device-auth.guard';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';

export class DeviceHealthDto {
  @IsBoolean()
  online!: boolean;

  @IsOptional()
  @IsInt()
  uptimeS?: number;

  @IsOptional()
  @IsInt()
  rssi?: number;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}

export class DeviceEventDto {
  @IsString()
  @MaxLength(40)
  type!: string;

  @IsOptional()
  @IsString()
  accessPointId?: string;

  @IsOptional()
  @IsInt()
  sequence?: number;

  @IsObject()
  payload!: Record<string, unknown>;
}

/**
 * Device-authenticated endpoints (per-device bearer token).
 * Identity and tenant scope derive from the token, never from the body.
 */
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
        accessPoints: { include: { accessPoint: { select: { id: true, name: true, type: true } } } },
      },
    });
  }

  @Post('health')
  async health(@Req() req: AuthedRequest, @Body() dto: DeviceHealthDto) {
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
      this.prisma.device.update({ where: { id: req.device!.id }, data: { lastSeenAt: new Date() } }),
    ]);
    return { ok: true };
  }

  @Post('events')
  async events(@Req() req: AuthedRequest, @Body() dto: DeviceEventDto) {
    if (dto.accessPointId) {
      // Scope check: the access point must belong to this device.
      const link = await this.prisma.deviceAccessPoint.findUnique({
        where: { deviceId_accessPointId: { deviceId: req.device!.id, accessPointId: dto.accessPointId } },
      });
      if (!link) return { ok: false, error: 'WRONG_ACCESS_POINT' };
    }
    await this.prisma.deviceEvent.create({
      data: {
        deviceId: req.device!.id,
        accessPointId: dto.accessPointId,
        type: dto.type as never,
        sequence: dto.sequence,
        payload: dto.payload as never,
      },
    });
    return { ok: true };
  }
}
