import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, JwtUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { paramStr } from '../common/params';
import { RegisterRelativeDto, QuickPassDto } from './relatives.dto';
import { RelativesService } from './relatives.service';

@ApiTags('relatives')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('flats/:flatId/relatives')
export class RelativesController {
  constructor(private readonly relativesService: RelativesService) {}

  @Get()
  async listRelatives(
    @CurrentUser() user: JwtUser,
    @Param('flatId') flatId: string,
  ) {
    return this.relativesService.listRelatives(user.sub, paramStr(flatId));
  }

  @Post()
  @HttpCode(201)
  async registerRelative(
    @CurrentUser() user: JwtUser,
    @Param('flatId') flatId: string,
    @Body() dto: RegisterRelativeDto,
  ) {
    return this.relativesService.registerRelative(user.sub, paramStr(flatId), dto);
  }

  @Post(':visitorId/quick-pass')
  @HttpCode(201)
  async issueQuickPass(
    @CurrentUser() user: JwtUser,
    @Param('flatId') flatId: string,
    @Param('visitorId') visitorId: string,
    @Body() dto: QuickPassDto,
  ) {
    return this.relativesService.issueQuickPass(
      user.sub,
      paramStr(flatId),
      paramStr(visitorId),
      dto,
    );
  }

  @Delete(':visitorId')
  @HttpCode(200)
  async deleteRelative(
    @CurrentUser() user: JwtUser,
    @Param('flatId') flatId: string,
    @Param('visitorId') visitorId: string,
  ) {
    return this.relativesService.deleteRelative(
      user.sub,
      paramStr(flatId),
      paramStr(visitorId),
    );
  }
}
