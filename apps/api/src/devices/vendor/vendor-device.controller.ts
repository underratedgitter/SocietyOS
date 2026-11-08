import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AuthedRequest, JwtAuthGuard, JwtUser } from '../../auth/jwt-auth.guard';
import { SocietyScopeGuard } from '../../auth/society-scope.guard';
import { RequireRoles } from '../../auth/require-roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { paramStr } from '../../common/params';
import { DeviceAuthGuard } from '../device-auth.guard';
import { BiometricIdentityService } from './biometric-identity.service';
import { BiometricIngestService } from './biometric-ingest.service';
import { DeviceSyncService } from './device-sync.service';
import { DEVICE_USER_ID_PATTERN, VERIFY_METHODS, VerifyMethod } from './vendor-event';

function toVerifyMethod(raw: string): VerifyMethod {
  return (VERIFY_METHODS as readonly string[]).includes(raw) ? (raw as VerifyMethod) : 'UNKNOWN';
}

/**
 * Only the shape is validated here. Content problems (bad ID, unparseable time, unknown method)
 * become per-event REJECTED outcomes in ingest, so one bad row never fails, and endlessly
 * re-sends, a whole batch from the edge connector.
 */
export class VendorBiometricEventDto {
  @IsString()
  @MaxLength(64)
  deviceUserId!: string;

  @IsString()
  @MaxLength(32)
  method!: string;

  @IsString()
  @MaxLength(64)
  occurredAt!: string;

  @IsBoolean()
  matched!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  vendorEventId?: string;
}

export class VendorBiometricBatchDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VendorBiometricEventDto)
  events!: VendorBiometricEventDto[];
}

export class SyncCommandAckDto {
  @IsBoolean()
  success!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  result?: string;
}

export class AssignBiometricIdentityDto {
  @IsUUID()
  userId!: string;

  /** Keep an ID already enrolled on existing terminals; omit to allocate the next free one. */
  @IsOptional()
  @Matches(DEVICE_USER_ID_PATTERN)
  deviceUserId?: string;
}

/**
 * Vendor-neutral endpoints used by the on-site edge connector or any middleware that can post
 * normalized events. Vendor push protocols (ZKTeco ADMS, Hikvision, Dahua) have their own
 * controllers that parse native payloads into the same ingest path.
 */
@ApiTags('device-api')
@Controller('device-api')
@UseGuards(DeviceAuthGuard)
export class VendorDeviceApiController {
  constructor(
    private readonly ingest: BiometricIngestService,
    private readonly sync: DeviceSyncService,
  ) {}

  @Post('biometric-events')
  @HttpCode(200)
  async biometricEvents(@Req() req: AuthedRequest, @Body() dto: VendorBiometricBatchDto) {
    const device = req.device!;
    const outcomes = await this.ingest.ingest(
      device,
      dto.events.map((event) => ({
        ...event,
        method: toVerifyMethod(event.method),
        occurredAt: new Date(event.occurredAt),
      })),
    );
    return { outcomes };
  }

  @Get('sync-commands')
  async pullSyncCommands(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    const commands = await this.sync.pull(req.device!.id, Number.isFinite(parsed) ? parsed : undefined);
    return {
      commands: commands.map((command) => ({ id: command.id, kind: command.kind, payload: command.payload })),
    };
  }

  @Post('sync-commands/:commandId/ack')
  @HttpCode(204)
  async ackSyncCommand(
    @Req() req: AuthedRequest,
    @Param('commandId', new ParseUUIDPipe()) commandId: string,
    @Body() dto: SyncCommandAckDto,
  ): Promise<void> {
    await this.sync.acknowledge(req.device!.id, commandId, dto.success, dto.result);
  }
}

@ApiTags('devices')
@ApiBearerAuth()
@Controller('societies/:societyId/biometric-identities')
@UseGuards(JwtAuthGuard, SocietyScopeGuard)
@RequireRoles('SOCIETY_ADMIN')
export class BiometricIdentityController {
  constructor(private readonly identities: BiometricIdentityService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.identities.list(paramStr(req.params.societyId));
  }

  @Post()
  assign(@CurrentUser() user: JwtUser, @Req() req: AuthedRequest, @Body() dto: AssignBiometricIdentityDto) {
    return this.identities.assign(user.sub, paramStr(req.params.societyId), dto.userId, dto.deviceUserId);
  }

  @Delete(':identityId')
  revoke(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('identityId', new ParseUUIDPipe()) identityId: string,
  ) {
    return this.identities.revoke(user.sub, paramStr(req.params.societyId), identityId);
  }
}
