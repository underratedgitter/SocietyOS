import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { DeviceAuthGuard } from '../devices/device-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { AuthzService } from '../common/authz.service';
import { RateLimitService } from '../common/rate-limit.service';
import { AppException } from '../common/app.exception';
import { AccessEngineService, VerifyContext } from './access-engine.service';
import { BiometricsService } from '../devices/biometrics.service';

export class AccessVerifyDto {
  @IsUUID()
  accessPointId!: string;

  @IsIn(['PIN', 'QR', 'BIOMETRIC', 'FINGERPRINT', 'FACE'])
  credentialType!: 'PIN' | 'QR' | 'BIOMETRIC' | 'FINGERPRINT' | 'FACE';

  @IsString()
  @MinLength(4)
  @MaxLength(128)
  credential!: string;

  @IsUUID()
  requestId!: string;
}

export class ManualVerifyDto {
  @IsUUID()
  accessPointId!: string;

  @IsIn(['PIN', 'QR', 'BIOMETRIC', 'FINGERPRINT', 'FACE'])
  credentialType!: 'PIN' | 'QR' | 'BIOMETRIC' | 'FINGERPRINT' | 'FACE';

  @IsString()
  @MinLength(4)
  @MaxLength(128)
  credential!: string;
}

export class EmergencyOverrideDto {
  @IsUUID()
  accessPointId!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(250)
  reason!: string;
}

@ApiTags('access')
@Controller('access')
export class AccessController {
  constructor(
    private readonly engine: AccessEngineService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rateLimit: RateLimitService,
    private readonly biometrics: BiometricsService,
  ) {}

  @Post('verify')
  @UseGuards(DeviceAuthGuard)
  @HttpCode(200)
  async verify(@Req() req: AuthedRequest, @Body() dto: AccessVerifyDto) {
    const device = req.device!;
    const accessPoint = await this.prisma.accessPoint.findFirst({
      where: {
        id: dto.accessPointId,
        societyId: device.societyId,
        devices: { some: { deviceId: device.id } },
      },
      select: { id: true },
    });
    if (!accessPoint) {
      throw AppException.forbidden('WRONG_ACCESS_POINT', 'This gate is not assigned to the device');
    }
    const ctx: VerifyContext = {
      societyId: device.societyId,
      accessPointId: dto.accessPointId,
      credentialType: dto.credentialType,
      credential: dto.credential,
      requestId: dto.requestId,
      source: 'DEVICE',
      deviceId: device.id,
      deviceUid: device.deviceUid,
    };
    return this.engine.verify(ctx);
  }

  @Post('manual-verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiBearerAuth()
  async manualVerify(@Req() req: AuthedRequest, @Body() dto: ManualVerifyDto) {
    const accessPoint = await this.prisma.accessPoint.findUnique({
      where: { id: dto.accessPointId },
      select: { id: true, societyId: true },
    });
    if (!accessPoint) {
      throw AppException.forbidden('WRONG_ACCESS_POINT', 'Access point not found');
    }
    await this.authz.society(req.user!.sub, accessPoint.societyId, ['SOCIETY_ADMIN', 'GUARD']);
    const limit = await this.rateLimit.hit(`manual-verify:${req.user!.sub}`, 60, 60);
    if (!limit.allowed) throw AppException.tooMany('Too many verification attempts. Try again shortly.');
    return this.engine.verify({
      societyId: accessPoint.societyId,
      accessPointId: dto.accessPointId,
      credentialType: dto.credentialType,
      credential: dto.credential,
      requestId: crypto.randomUUID(),
      source: 'GUARD_CONSOLE',
      actorUserId: req.user!.sub,
    });
  }

  @Post('emergency-override')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiBearerAuth()
  async emergencyOverride(@Req() req: AuthedRequest, @Body() dto: EmergencyOverrideDto) {
    const accessPoint = await this.prisma.accessPoint.findUnique({
      where: { id: dto.accessPointId },
      select: { id: true, societyId: true },
    });
    if (!accessPoint) {
      throw AppException.forbidden('WRONG_ACCESS_POINT', 'Access point not found');
    }
    const context = await this.authz.society(req.user!.sub, accessPoint.societyId, ['SOCIETY_ADMIN', 'GUARD']);
    return this.biometrics.triggerEmergencyOverride(
      accessPoint.societyId,
      req.user!.sub,
      context.role,
      dto.accessPointId,
      dto.reason,
    );
  }

  @Post('emergency-reset')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiBearerAuth()
  async emergencyReset(@Req() req: AuthedRequest, @Body() dto: EmergencyOverrideDto) {
    const accessPoint = await this.prisma.accessPoint.findUnique({
      where: { id: dto.accessPointId },
      select: { id: true, societyId: true },
    });
    if (!accessPoint) {
      throw AppException.forbidden('WRONG_ACCESS_POINT', 'Access point not found');
    }
    const context = await this.authz.society(req.user!.sub, accessPoint.societyId, ['SOCIETY_ADMIN', 'GUARD']);
    return this.biometrics.resetEmergencyOverride(
      accessPoint.societyId,
      req.user!.sub,
      context.role,
      dto.accessPointId,
      dto.reason,
    );
  }
}

