import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AuthedRequest } from '../auth/jwt-auth.guard';

/**
 * Devices authenticate with a per-device bearer token issued once at
 * provisioning. Identity, tenant and access-point scope are derived from the
 * stored record — never from the request body (blueprint §5).
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('DEVICE_UNAUTHENTICATED');
    }
    const token = header.slice(7);
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const credential = await this.prisma.deviceCredential.findUnique({
      where: { tokenHash },
      include: { device: true },
    });
    if (!credential || credential.revokedAt) {
      throw new UnauthorizedException('DEVICE_UNAUTHENTICATED');
    }
    if (credential.device.status !== 'ACTIVE') {
      throw new UnauthorizedException('DEVICE_DISABLED', 'Device is disabled or revoked');
    }
    req.device = {
      id: credential.device.id,
      deviceUid: credential.device.deviceUid,
      societyId: credential.device.societyId,
      name: credential.device.name,
    };
    return true;
  }
}
