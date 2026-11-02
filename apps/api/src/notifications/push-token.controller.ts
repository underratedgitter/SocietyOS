import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, JwtUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { RegisterPushTokenDto, UnregisterPushTokenDto } from './push-token.dto';

export function validateWebPushEndpoint(endpoint?: string | null): void {
  if (!endpoint) return;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw AppException.badRequest('INVALID_PUSH_ENDPOINT', 'Web push endpoint must be a valid URL');
  }

  if (url.protocol !== 'https:') {
    throw AppException.badRequest('INVALID_PUSH_ENDPOINT', 'Web push endpoint must use HTTPS protocol');
  }

  const hostname = url.hostname.toLowerCase();
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  // Deny loopback / localhost / unqualified internal domain names
  if (
    cleanHost === 'localhost' ||
    cleanHost === '127.0.0.1' ||
    cleanHost === '::1' ||
    cleanHost === '::' ||
    cleanHost === '0.0.0.0' ||
    cleanHost.endsWith('.localhost') ||
    !cleanHost.includes('.') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal') ||
    cleanHost.endsWith('.lan') ||
    cleanHost.endsWith('.home') ||
    cleanHost.endsWith('.corp')
  ) {
    throw AppException.badRequest('DISALLOWED_PUSH_ENDPOINT', 'Web push endpoint targets localhost or internal domain');
  }

  // Deny cloud metadata service
  if (cleanHost === '169.254.169.254' || cleanHost.startsWith('169.254.')) {
    throw AppException.badRequest('DISALLOWED_PUSH_ENDPOINT', 'Web push endpoint targets cloud metadata service');
  }

  // Deny private / reserved IPv4 ranges
  const ipv4Match = cleanHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (
      a === 0 || // RFC 1122 'this' network
      a === 10 || // RFC 1918
      a === 127 || // RFC 1122 Loopback
      (a === 100 && b >= 64 && b <= 127) || // RFC 6598 Shared Address Space / CGNAT
      (a === 169 && b === 254) || // RFC 3927 Link Local / Cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // RFC 1918
      (a === 192 && b === 0) || // RFC 6890 IETF Protocol Assignments
      (a === 192 && b === 2) || // RFC 5737 TEST-NET-1
      (a === 192 && b === 168) || // RFC 1918
      (a === 198 && (b === 18 || b === 19)) || // RFC 2544 Benchmarking
      (a === 198 && b === 51) || // RFC 5737 TEST-NET-2
      (a === 203 && b === 0) || // RFC 5737 TEST-NET-3
      a >= 224 // RFC 5771 Multicast & Reserved
    ) {
      throw AppException.badRequest('DISALLOWED_PUSH_ENDPOINT', 'Web push endpoint targets private or reserved IP address');
    }
  }

  // Deny private / mapped / reserved IPv6
  if (cleanHost.includes(':')) {
    if (
      cleanHost === '::1' ||
      cleanHost === '::' ||
      cleanHost.startsWith('::ffff:') || // IPv4-mapped IPv6
      cleanHost.startsWith('64:ff9b:') || // NAT64
      cleanHost.startsWith('fe80:') || // Link-local
      cleanHost.startsWith('fc') || // ULA
      cleanHost.startsWith('fd') || // ULA
      cleanHost.startsWith('ff') || // Multicast
      cleanHost.startsWith('2001:db8:') // Documentation
    ) {
      throw AppException.badRequest('DISALLOWED_PUSH_ENDPOINT', 'Web push endpoint targets private, loopback, or mapped IPv6 address');
    }
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications/push-token')
export class PushTokenController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @ApiOperation({ summary: 'Register or update device push token for notifications' })
  async registerToken(@CurrentUser() user: JwtUser, @Body() dto: RegisterPushTokenDto) {
    if (dto.endpoint) {
      validateWebPushEndpoint(dto.endpoint);
    }
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
