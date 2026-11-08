import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { AuthedRequest } from '../auth/jwt-auth.guard';
import { sha256 } from '../common/crypto.util';

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw AppException.unauthorized('DEVICE_UNAUTHENTICATED', 'Device authentication required');
    }
    const token = header.slice(7).trim();
    if (token.length < 20 || token.length > 256) {
      throw AppException.unauthorized('DEVICE_UNAUTHENTICATED', 'Device authentication required');
    }

    const credential = await this.prisma.deviceCredential.findUnique({
      where: { tokenHash: sha256(token) },
      include: { device: true },
    });
    if (!credential || credential.revokedAt) {
      throw AppException.unauthorized('DEVICE_UNAUTHENTICATED', 'Device authentication required');
    }
    if (credential.device.status !== 'ACTIVE') {
      throw AppException.unauthorized('DEVICE_DISABLED', 'This device is disabled');
    }
    request.device = {
      id: credential.device.id,
      deviceUid: credential.device.deviceUid,
      societyId: credential.device.societyId,
      name: credential.device.name,
      protocol: credential.device.protocol,
    };
    request.authSource = 'bearer';
    return true;
  }
}
