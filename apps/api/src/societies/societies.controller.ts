import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SocietyScopeGuard } from '../auth/society-scope.guard';
import { FlatScopeGuard } from '../auth/flat-scope.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles } from '../auth/require-roles.decorator';
import { AuthedRequest, JwtUser } from '../auth/jwt-auth.guard';
import { SocietiesService } from './societies.service';
import {
  AddFlatMemberDto,
  CreateBuildingDto,
  CreateFlatDto,
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
    return this.societies.createSociety(
      { sub: user!.sub, isPlatformAdmin: user!.isPlatformAdmin },
      dto,
    );
  }

  @Get('societies')
  listMine(@CurrentUser() user: JwtUser) {
    return this.societies.listMine(user!.sub);
  }

  @Get('societies/:societyId')
  @UseGuards(SocietyScopeGuard)
  getSociety(@Req() req: AuthedRequest) {
    return this.societies.getSociety(paramStr(req.params.societyId));
  }

  @Patch('societies/:societyId')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  updateSociety(@Req() req: AuthedRequest, @Body() dto: UpdateSocietyDto) {
    return this.societies.updateSociety(req, dto);
  }

  @Post('societies/:societyId/buildings')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  createBuilding(@Req() req: AuthedRequest, @Body() dto: CreateBuildingDto) {
    return this.societies.createBuilding(req, dto);
  }

  @Get('societies/:societyId/buildings')
  @UseGuards(SocietyScopeGuard)
  listBuildings(@Req() req: AuthedRequest) {
    return this.societies.listBuildings(paramStr(req.params.societyId));
  }

  @Post('societies/:societyId/flats')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  createFlatForSociety(@Req() req: AuthedRequest, @Body() dto: CreateFlatDto & { buildingId: string }) {
    return this.societies.createFlat(req, dto.buildingId, { flatNumber: dto.flatNumber });
  }

  @Get('societies/:societyId/flats')
  @UseGuards(SocietyScopeGuard)
  listFlats(@Req() req: AuthedRequest) {
    return this.societies.listFlats(paramStr(req.params.societyId));
  }

  @Post('buildings/:buildingId/flats')
  @UseGuards(JwtAuthGuard)
  createFlatInBuilding(@Req() req: AuthedRequest, @Param('buildingId') buildingId: string, @Body() dto: CreateFlatDto) {
    return this.societies.createFlat(req, buildingId, dto);
  }

  @Post('societies/:societyId/residents')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  inviteResident(@Req() req: AuthedRequest, @Body() dto: InviteResidentDto) {
    return this.societies.inviteResident(req, dto);
  }

  @Get('societies/:societyId/residents')
  @UseGuards(SocietyScopeGuard)
  @RequireRoles('SOCIETY_ADMIN', 'GUARD')
  listResidents(@Req() req: AuthedRequest) {
    return this.societies.listResidents(paramStr(req.params.societyId));
  }

  @Post('flats/:flatId/members')
  @UseGuards(JwtAuthGuard, FlatScopeGuard)
  addFlatMember(@Req() req: AuthedRequest, @Param('flatId') flatId: string, @Body() dto: AddFlatMemberDto) {
    return this.societies.addFlatMember(req, flatId, dto);
  }

  @Delete('flats/:flatId/members/:userId')
  @UseGuards(JwtAuthGuard, FlatScopeGuard)
  @RequireRoles('SOCIETY_ADMIN')
  removeFlatMember(@Req() req: AuthedRequest, @Param('flatId') flatId: string, @Param('userId') userId: string) {
    return this.societies.removeFlatMember(req, flatId, userId);
  }
}
