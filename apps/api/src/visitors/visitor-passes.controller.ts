import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FlatScopeGuard } from '../auth/flat-scope.guard';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { VisitorPassesService } from './visitor-passes.service';
import { IdempotencyService } from './idempotency.service';
import { CreateVisitorPassDto, DecidePassDto } from './visitor-passes.dto';

@ApiTags('visitors')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class VisitorPassesController {
  constructor(
    private readonly passes: VisitorPassesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('visitor-passes')
  async create(
    @Req() req: AuthedRequest,
    @Body() dto: CreateVisitorPassDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const cached = await this.idempotency.get(`visitor-passes:${idempotencyKey}`);
      if (cached) return cached;
    }
    const result = await this.passes.create(req, dto);
    if (idempotencyKey) {
      await this.idempotency.save(`visitor-passes:${idempotencyKey}`, 'visitor-passes', result);
    }
    return result;
  }

  @Get('visitor-passes')
  list(
    @Req() req: AuthedRequest,
    @Query('societyId') societyId?: string,
    @Query('status') status?: string,
    @Query('flatId') flatId?: string,
  ) {
    return this.passes.list(req, { societyId, status, flatId });
  }

  @Get('visitor-passes/:passId')
  getOne(@Req() req: AuthedRequest, @Param('passId') passId: string) {
    return this.passes.getAuthorized(req, passId);
  }

  @Post('visitor-passes/:passId/approve')
  @HttpCode(200)
  approve(@Req() req: AuthedRequest, @Param('passId') passId: string, @Body() dto: DecidePassDto) {
    return this.passes.approve(req, passId, dto);
  }

  @Post('visitor-passes/:passId/revoke')
  @HttpCode(200)
  revoke(@Req() req: AuthedRequest, @Param('passId') passId: string) {
    return this.passes.revoke(req, passId);
  }

  @Get('flats/:flatId/access-points')
  @UseGuards(FlatScopeGuard)
  accessPointsForFlat(@Req() req: AuthedRequest, @Param('flatId') flatId: string) {
    return this.passes.accessPointsForFlat(req, flatId);
  }
}
