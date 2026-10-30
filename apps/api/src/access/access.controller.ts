import { Body, Controller, ForbiddenException, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { DeviceAuthGuard } from '../devices/device-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { AccessEngineService, VerifyContext } from './access-engine.service';

export class AccessVerifyDto {
  @IsString()
  accessPointId!: string;

  @IsIn(['PIN', 'QR'])
  credentialType!: 'PIN' | 'QR';

  @IsString()
  @MinLength(4)
  @MaxLength(64)
  credential!: string;

  @IsUUID()
  requestId!: string;
}

export class ManualVerifyDto {
  @IsString()
  accessPointId!: string;

  @IsIn(['PIN', 'QR'])
  credentialType!: 'PIN' | 'QR';

  @IsString()
  @MinLength(4)
  @MaxLength(64)
  credential!: string;
}

/**
 * POST /access/verify — called by an authenticated gate terminal with the
 * credential and access-point context. The device identity derives from the
 * bearer token; the kiosk's claims about society/role are never trusted.
 */
@ApiTags('access')
@Controller('access')
export class AccessController {
  constructor(
    private readonly engine: AccessEngineService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('verify')
  @UseGuards(DeviceAuthGuard)
  @HttpCode(200)
  async verify(@Req() req: AuthedRequest, @Body() dto: AccessVerifyDto) {
    const ctx: VerifyContext = {
      societyId: req.device!.societyId,
      accessPointId: dto.accessPointId,
      credentialType: dto.credentialType,
      credential: dto.credential,
      requestId: dto.requestId,
      source: 'DEVICE',
      deviceId: req.device!.id,
      deviceUid: req.device!.deviceUid,
    };
    return this.engine.verify(ctx);
  }

  @Post('manual-verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiBearerAuth()
  async manualVerify(@Req() req: AuthedRequest, @Body() dto: ManualVerifyDto) {
    const membership = await this.prisma.societyMembership.findFirst({
      where: { userId: req.user!.sub, status: 'ACTIVE', role: { in: ['GUARD', 'SOCIETY_ADMIN'] } },
    });
    if (!membership) throw new ForbiddenException('GUARD_ROLE_REQUIRED');

    const ap = await this.prisma.accessPoint.findUnique({ where: { id: dto.accessPointId } });
    if (!ap || ap.societyId !== membership.societyId) {
      throw AppException.forbidden('WRONG_ACCESS_POINT', 'Access point does not belong to your society');
    }
    return this.engine.verify({
      societyId: membership.societyId,
      accessPointId: dto.accessPointId,
      credentialType: dto.credentialType,
      credential: dto.credential,
      requestId: crypto.randomUUID(),
      source: 'GUARD_CONSOLE',
      actorUserId: req.user!.sub,
    });
  }
}
