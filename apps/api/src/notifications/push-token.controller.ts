import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, JwtUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../common/prisma.service';
import { RegisterPushTokenDto, UnregisterPushTokenDto } from './push-token.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications/push-token')
export class PushTokenController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @ApiOperation({ summary: 'Register or update device push token for notifications' })
  async registerToken(@CurrentUser() user: JwtUser, @Body() dto: RegisterPushTokenDto) {
    const record = await this.prisma.pushDeviceToken.upsert({
      where: { token: dto.token },
      create: {
        userId: user.sub,
        token: dto.token,
        platform: dto.platform || 'expo',
        deviceName: dto.deviceName,
        endpoint: dto.endpoint,
        p256dh: dto.p256dh,
        auth: dto.auth,
      },
      update: {
        userId: user.sub,
        platform: dto.platform || 'expo',
        deviceName: dto.deviceName,
        endpoint: dto.endpoint,
        p256dh: dto.p256dh,
        auth: dto.auth,
        updatedAt: new Date(),
      },
    });

    return {
      ok: true,
      id: record.id,
      platform: record.platform,
    };
  }

  @Delete()
  @ApiOperation({ summary: 'Unregister device push token upon logout' })
  async unregisterToken(@CurrentUser() user: JwtUser, @Body() dto: UnregisterPushTokenDto) {
    await this.prisma.pushDeviceToken.deleteMany({
      where: {
        token: dto.token,
        userId: user.sub,
      },
    });
    return { ok: true };
  }

  @Get()
  @ApiOperation({ summary: 'List registered push devices for the current user' })
  async listTokens(@CurrentUser() user: JwtUser) {
    return this.prisma.pushDeviceToken.findMany({
      where: { userId: user.sub },
      select: {
        id: true,
        platform: true,
        deviceName: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
