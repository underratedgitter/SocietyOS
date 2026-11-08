import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SocietyScopeGuard } from '../auth/society-scope.guard';
import { RequireRoles } from '../auth/require-roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthedRequest, JwtUser } from '../auth/jwt-auth.guard';
import { paramStr } from '../common/params';
import { DevicesService } from './devices.service';
import { BiometricsService } from './biometrics.service';
import {
  BiometricEnrollRequestDto,
  BiometricVerifyRequestDto,
  CreateAccessPointDto,
  EmergencyOverrideDto,
  ProvisionDeviceDto,
} from './devices.dto';

function limitValue(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

@ApiTags('devices')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly biometrics: BiometricsService,
  ) {}

  @Post('societies/:societyId/access-points')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  createAccessPoint(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest, @Body() dto: CreateAccessPointDto) {
    return this.devices.createAccessPoint(
      user,
      req.membership!.role,
      paramStr(req.params.societyId),
      dto,
    );
  }

  @Get('societies/:societyId/access-points')
  @UseGuards(SocietyScopeGuard)
  listAccessPoints(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest) {
    return this.devices.listAccessPoints(user, paramStr(req.params.societyId));
  }

  @Post('societies/:societyId/devices')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  provisionDevice(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest, @Body() dto: ProvisionDeviceDto) {
    return this.devices.provisionDevice(
      user,
      req.membership!.role,
      paramStr(req.params.societyId),
      dto,
    );
  }

  @Get('societies/:societyId/devices')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  listDevices(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest) {
    return this.devices.listDevices(user, paramStr(req.params.societyId));
  }

  @Get('societies/:societyId/access-events')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  accessEvents(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('accessPointId') accessPointId?: string,
  ) {
    return this.devices.accessEvents(user, paramStr(req.params.societyId), {
      limit: limitValue(limit),
      accessPointId,
    });
  }

  @Get('societies/:societyId/gate-commands')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  gateCommands(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
  ) {
    return this.devices.gateCommands(user, paramStr(req.params.societyId), limitValue(limit));
  }

  @Get('devices/:deviceId/health')
  deviceHealth(@CurrentUser() user: JwtUser, @Param('deviceId') deviceId: string) {
    return this.devices.deviceHealth(user, paramStr(deviceId));
  }

  @Post('devices/:deviceId/disable')
  disableDevice(@CurrentUser() user: JwtUser, @Param('deviceId') deviceId: string) {
    return this.devices.setDeviceStatus(user, paramStr(deviceId), 'DISABLED');
  }

  @Post('devices/:deviceId/enable')
  enableDevice(@CurrentUser() user: JwtUser, @Param('deviceId') deviceId: string) {
    return this.devices.setDeviceStatus(user, paramStr(deviceId), 'ACTIVE');
  }

  @Post('devices/:deviceId/rotate-credential')
  rotateCredential(@CurrentUser() user: JwtUser, @Param('deviceId') deviceId: string) {
    return this.devices.rotateDeviceCredential(user, paramStr(deviceId));
  }

  @Post('societies/:societyId/access-points/:accessPointId/emergency-override')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  emergencyOverride(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('accessPointId') accessPointId: string,
    @Body() dto: EmergencyOverrideDto,
  ) {
    return this.biometrics.triggerEmergencyOverride(
      paramStr(req.params.societyId),
      user.sub,
      req.membership!.role,
      paramStr(accessPointId),
      dto.reason,
    );
  }

  @Post('societies/:societyId/access-points/:accessPointId/emergency-reset')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  emergencyReset(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('accessPointId') accessPointId: string,
    @Body() dto: EmergencyOverrideDto,
  ) {
    return this.biometrics.resetEmergencyOverride(
      paramStr(req.params.societyId),
      user.sub,
      req.membership!.role,
      paramStr(accessPointId),
      dto.reason,
    );
  }

  @Get('societies/:societyId/access-points/:accessPointId/telemetry')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  gateTelemetry(
    @Req() req: AuthedRequest,
    @Param('accessPointId') accessPointId: string,
  ) {
    return this.biometrics.getGateTelemetry(
      paramStr(req.params.societyId),
      paramStr(accessPointId),
    );
  }

  @Post('societies/:societyId/biometrics/enroll')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  enrollBiometric(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Body() dto: BiometricEnrollRequestDto,
  ) {
    return this.biometrics.enrollResidentBiometric(
      user.sub,
      paramStr(req.params.societyId),
      dto,
    );
  }

  @Post('societies/:societyId/biometrics/verify')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  verifyBiometric(
    @Req() req: AuthedRequest,
    @Body() dto: BiometricVerifyRequestDto,
  ) {
    return this.biometrics.verifyResidentBiometric(
      paramStr(req.params.societyId),
      dto,
    );
  }

  @Get('societies/:societyId/dpdp/compliance-report')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  dpdpComplianceReport(@Req() req: AuthedRequest) {
    return this.biometrics.getDpdpComplianceReport(paramStr(req.params.societyId));
  }

  @Post('societies/:societyId/dpdp/anonymize-expired')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  anonymizeExpiredVisitorData(@Req() req: AuthedRequest) {
    return this.biometrics.anonymizeExpiredVisitorData(paramStr(req.params.societyId));
  }
}
