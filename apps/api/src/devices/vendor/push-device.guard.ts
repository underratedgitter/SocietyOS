import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DeviceProtocol } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AppException } from '../../common/app.exception';
import { RateLimitService } from '../../common/rate-limit.service';
import { AuthedRequest } from '../../auth/jwt-auth.guard';
import { sha256 } from '../../common/crypto.util';
import { paramStr } from '../../common/params';

export const PUSH_PROTOCOL_KEY = 'devicePushProtocol';
/** Declares which device protocol a push route serves; the guard rejects any other device. */
export const PushProtocol = (protocol: DeviceProtocol): MethodDecorator & ClassDecorator =>
  SetMetadata(PUSH_PROTOCOL_KEY, protocol);

/** Hard cap on push request bodies (Hikvision multipart events can carry a picture). */
export const PUSH_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PUSH_RATE_LIMIT_PER_MINUTE = 120;
export const PUSH_FAILED_AUTH_PER_MINUTE = 30;

export interface PushDevice {
  id: string;
  deviceUid: string;
  societyId: string;
  name: string;
  protocol: DeviceProtocol;
}

function normalizeIp(ip: string | undefined): string {
  return (ip ?? '').replace(/^::ffff:/i, '');
}

/**
 * Token-in-URL device auth for terminals that cannot send an Authorization header (Hikvision
 * ISAPI listening host, Dahua event upload). Same credential lookup as DeviceAuthGuard (SHA-256 of
 * the token against DeviceCredential), plus protocol match, optional source-IP allowlist and a
 * per-device rate limit. The token is never logged; nginx redacts it from access logs.
 */
@Injectable()
export class PushDeviceGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const expected = this.reflector.getAllAndOverride<DeviceProtocol | undefined>(PUSH_PROTOCOL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!expected) throw new Error('PushDeviceGuard requires @PushProtocol on the route');

    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > PUSH_MAX_BODY_BYTES) {
      throw new AppException('PUSH_BODY_TOO_LARGE', 'Request body too large', HttpStatus.PAYLOAD_TOO_LARGE);
    }

    const clientIp = normalizeIp(request.ip);
    const token = paramStr(request.params?.token as string | string[] | undefined).trim();
    const credential =
      token.length >= 20 && token.length <= 256
        ? await this.prisma.deviceCredential.findUnique({
            where: { tokenHash: sha256(token) },
            include: { device: true },
          })
        : null;
    if (!credential || credential.revokedAt) {
      // Throttle token guessing per source address; successful traffic is not counted here.
      const hit = await this.rateLimit.hit(`device-push-fail:${clientIp}`, PUSH_FAILED_AUTH_PER_MINUTE, 60);
      if (!hit.allowed) throw AppException.tooMany();
      throw AppException.unauthorized('DEVICE_UNAUTHENTICATED', 'Device authentication required');
    }
    const device = credential.device;
    if (device.status !== 'ACTIVE') {
      throw AppException.unauthorized('DEVICE_DISABLED', 'This device is disabled');
    }
    if (device.protocol !== expected) {
      throw AppException.forbidden('DEVICE_PROTOCOL_MISMATCH', 'This device is not configured for this endpoint');
    }
    if (device.pushAllowedIps.length > 0 && !device.pushAllowedIps.map(normalizeIp).includes(clientIp)) {
      throw AppException.forbidden('DEVICE_IP_NOT_ALLOWED', 'Source address not allowed for this device');
    }
    const limit = await this.rateLimit.hit(`device-push:${device.id}`, PUSH_RATE_LIMIT_PER_MINUTE, 60);
    if (!limit.allowed) throw AppException.tooMany();

    request.device = {
      id: device.id,
      deviceUid: device.deviceUid,
      societyId: device.societyId,
      name: device.name,
      protocol: device.protocol,
    };
    request.authSource = 'bearer';
    return true;
  }
}
