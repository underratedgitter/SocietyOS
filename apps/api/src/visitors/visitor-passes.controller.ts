import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtUser } from '../auth/jwt-auth.guard';
import { paramStr } from '../common/params';
import { AppException } from '../common/app.exception';
import { VisitorPassesService } from './visitor-passes.service';
import { IdempotencyService } from './idempotency.service';
import {
  CreateVisitorPassDto,
  DecidePassDto,
  ListPassesQueryDto,
  RevokePassDto,
} from './visitor-passes.dto';

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

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
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateVisitorPassDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) return this.passes.create(user, dto);
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new AppException(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be 8-128 URL-safe characters',
        400,
      );
    }
    const key = `visitor-passes:${user.sub}:${idempotencyKey}`;
    const fingerprint = this.idempotency.fingerprint(dto);
    const cached = await this.idempotency.get(key, 'visitor-passes.create', fingerprint);
    if (cached) return cached;
    const result = await this.passes.create(user, dto);
    const { credentials: _, ...sanitized } = result;
    const toCache = {
      ...sanitized,
      credentialsAlreadyIssued: true,
    };
    await this.idempotency.save(key, 'visitor-passes.create', fingerprint, toCache, 24);
    return result;
  }

  @Get('visitor-passes')
  list(@CurrentUser() user: JwtUser, @Query() query: ListPassesQueryDto) {
    return this.passes.list(user, query);
  }

  @Get('visitor-passes/:passId')
  getOne(@CurrentUser() user: JwtUser, @Param('passId') passId: string) {
    return this.passes.getAuthorized(user, paramStr(passId));
  }

  @Post('visitor-passes/:passId/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: JwtUser,
    @Param('passId') passId: string,
    @Body() dto: DecidePassDto,
  ) {
    return this.passes.approve(user, paramStr(passId), dto);
  }

  @Post('visitor-passes/:passId/revoke')
  @HttpCode(200)
  revoke(
    @CurrentUser() user: JwtUser,
    @Param('passId') passId: string,
    @Body() dto: RevokePassDto,
  ) {
    return this.passes.revoke(user, paramStr(passId), dto.reason);
  }

  @Get('flats/:flatId/access-points')
  accessPointsForFlat(@CurrentUser() user: JwtUser, @Param('flatId') flatId: string) {
    return this.passes.accessPointsForFlat(user, paramStr(flatId));
  }
}
