import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SocietyScopeGuard } from '../auth/society-scope.guard';
import { RequireRoles } from '../auth/require-roles.decorator';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { paramStr } from '../common/params';
import { DevicesService } from './devices.service';
import { CreateAccessPointDto, ProvisionDeviceDto } from './devices.dto';

@ApiTags('devices')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post('societies/:societyId/access-points')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  createAccessPoint(@Req() req: AuthedRequest, @Body() dto: CreateAccessPointDto) {
    return this.devices.createAccessPoint(req, dto);
  }

  @Get('societies/:societyId/access-points')
  @UseGuards(SocietyScopeGuard)
  listAccessPoints(@Req() req: AuthedRequest) {
    return this.devices.listAccessPoints(paramStr(req.params.societyId));
  }

  @Post('societies/:societyId/devices')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  provisionDevice(@Req() req: AuthedRequest, @Body() dto: ProvisionDeviceDto) {
    return this.devices.provisionDevice(req, dto);
  }

  @Get('societies/:societyId/devices')
  @UseGuards(SocietyScopeGuard)
  listDevices(@Req() req: AuthedRequest) {
    return this.devices.listDevices(paramStr(req.params.societyId));
  }

  @Get('societies/:societyId/access-events')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  accessEvents(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('accessPointId') accessPointId?: string,
  ) {
    return this.devices.accessEvents(paramStr(req.params.societyId), {
      limit: limit ? parseInt(limit, 10) : undefined,
      accessPointId,
    });
  }

  @Get('societies/:societyId/gate-commands')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  gateCommands(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.devices.gateCommands(paramStr(req.params.societyId), { limit: limit ? parseInt(limit, 10) : undefined });
  }

  @Get('devices/:deviceId/health')
  deviceHealth(@Req() req: AuthedRequest, @Param('deviceId') deviceId: string) {
    return this.devices.deviceHealth(req, deviceId);
  }

  @Post('devices/:deviceId/disable')
  disableDevice(@Req() req: AuthedRequest, @Param('deviceId') deviceId: string) {
    return this.devices.setDeviceStatus(req, deviceId, 'DISABLED');
  }

  @Post('devices/:deviceId/enable')
  enableDevice(@Req() req: AuthedRequest, @Param('deviceId') deviceId: string) {
    return this.devices.setDeviceStatus(req, deviceId, 'ACTIVE');
  }
}
