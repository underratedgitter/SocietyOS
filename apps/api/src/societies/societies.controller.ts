import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SocietyScopeGuard } from '../auth/society-scope.guard';
import { RequireRoles } from '../auth/require-roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthedRequest, JwtUser } from '../auth/jwt-auth.guard';
import { paramStr } from '../common/params';
import { SocietiesService } from './societies.service';
import {
  AddFlatMemberDto,
  CreateBuildingDto,
  CreateFlatDto,
  CreateGuardDto,
  CreateSocietyDto,
  InviteResidentDto,
  UpdateSocietyDto,
} from './societies.dto';

@ApiTags('society')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class SocietiesController {
  constructor(private readonly societies: SocietiesService) {}

  @Post('societies')
  createSociety(@CurrentUser() user: JwtUser, @Body() dto: CreateSocietyDto) {
    return this.societies.createSociety(user!, dto);
  }

  @Get('societies')
  listMine(@CurrentUser() user: JwtUser) {
    return this.societies.listMine(user!.sub, user!.isPlatformAdmin);
  }

  @Get('societies/:societyId/overview')
  @UseGuards(SocietyScopeGuard)
  overview(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest) {
    return this.societies.overview(user!.sub, paramStr(req.params.societyId));
  }

  @Get('societies/:societyId/audit-logs')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  auditLogs(@Req() req: AuthedRequest) {
    return this.societies.auditLogs(paramStr(req.params.societyId));
  }

  @Get('societies/:societyId/security-alerts')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  securityAlerts(@Req() req: AuthedRequest) {
    return this.societies.securityAlerts(paramStr(req.params.societyId));
  }

  @Get('societies/:societyId')
  @UseGuards(SocietyScopeGuard)
  getSociety(@Req() req: AuthedRequest) {
    return this.societies.getSociety(paramStr(req.params.societyId));
  }

  @Patch('societies/:societyId')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  updateSociety(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest, @Body() dto: UpdateSocietyDto) {
    return this.societies.updateSociety(user!, req.membership!.role, paramStr(req.params.societyId), dto);
  }

  @Post('societies/:societyId/buildings')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  createBuilding(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest, @Body() dto: CreateBuildingDto) {
    return this.societies.createBuilding(user!, req.membership!.role, paramStr(req.params.societyId), dto);
  }

  @Get('societies/:societyId/buildings')
  @UseGuards(SocietyScopeGuard)
  listBuildings(@Req() req: AuthedRequest) {
    return this.societies.listBuildings(paramStr(req.params.societyId));
  }

  @Post('buildings/:buildingId/flats')
  @UseGuards(JwtAuthGuard)
  createFlat(
    @CurrentUser() user: JwtUser,
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateFlatDto,
  ) {
    return this.societies.createFlat(user!, buildingId, dto);
  }

  @Get('societies/:societyId/flats')
  @UseGuards(SocietyScopeGuard)
  listFlats(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest) {
    return this.societies.listFlats(user!.sub, paramStr(req.params.societyId));
  }

  @Post('societies/:societyId/residents')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  inviteResident(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest, @Body() dto: InviteResidentDto) {
    return this.societies.inviteResident(
      user!,
      req.membership!.role,
      paramStr(req.params.societyId),
      dto,
    );
  }

  @Get('societies/:societyId/residents')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  listResidents(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest) {
    return this.societies.listResidents(
      user!.sub,
      paramStr(req.params.societyId),
    );
  }

  @Get('societies/:societyId/staff')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  listStaff(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest) {
    return this.societies.listStaff(user!.sub, paramStr(req.params.societyId));
  }

  @Post('societies/:societyId/guards')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  createGuard(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest, @Body() dto: CreateGuardDto) {
    return this.societies.createGuard(
      user!,
      req.membership!.role,
      paramStr(req.params.societyId),
      dto,
    );
  }

  @Post('flats/:flatId/members')
  @UseGuards(JwtAuthGuard)
  addFlatMember(
    @CurrentUser() user: JwtUser,
    @Param('flatId') flatId: string,
    @Body() dto: AddFlatMemberDto,
  ) {
    return this.societies.addFlatMember(user!, flatId, dto);
  }

  @Delete('flats/:flatId/members/:userId')
  @UseGuards(JwtAuthGuard)
  removeFlatMember(
    @CurrentUser() user: JwtUser,
    @Param('flatId') flatId: string,
    @Param('userId') userId: string,
  ) {
    return this.societies.removeFlatMember(user!, flatId, userId);
  }

  @Get('flats/:flatId/household')
  @UseGuards(JwtAuthGuard)
  household(@CurrentUser() user: JwtUser, @Param('flatId') flatId: string) {
    return this.societies.household(user!.sub, flatId);
  }
}
