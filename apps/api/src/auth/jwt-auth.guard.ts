import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { parseCookies } from '../common/crypto.util';
import { getEnv } from '../config';
import { ACCESS_COOKIE } from './auth.constants';
import { DeviceProtocol } from '@prisma/client';

export interface JwtUser {
  sub: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
}

export interface AuthedRequest extends Request {
  user?: JwtUser;
  authSource?: 'bearer' | 'cookie';
  membership?: { societyId: string; role: string };
  flat?: { id: string; societyId: string };
  device?: { id: string; deviceUid: string; societyId: string; name: string; protocol: DeviceProtocol };
}

const PASSWORD_CHANGE_ALLOWED_PATHS = [
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/change-password',
  '/auth/me',
  '/auth/logout',
  '/auth/change-password',
];

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    let token: string | undefined;
    let source: 'bearer' | 'cookie' = 'bearer';

    if (header?.startsWith('Bearer ')) {
      token = header.slice(7);
    } else {
      token = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
      source = 'cookie';
    }
    if (!token) throw AppException.unauthorized('UNAUTHENTICATED', 'Authentication required');

    if (source === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      if (origin && !getEnv().corsOrigins.includes(origin.replace(/\/$/, ''))) {
        throw AppException.forbidden('CSRF_ORIGIN_REJECTED', 'Request origin is not allowed');
      }
    }

    const env = getEnv();
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, env.jwtAccessSecret, {
        algorithms: ['HS256'],
        issuer: env.jwtIssuer,
        audience: env.jwtAudience,
      }) as jwt.JwtPayload;
    } catch {
      throw AppException.unauthorized('UNAUTHENTICATED', 'Authentication required');
    }
    if (!payload.sub || payload.typ !== 'access') {
      throw AppException.unauthorized('UNAUTHENTICATED', 'Authentication required');
    }

    // Reload server-side state so disabled accounts, role changes and forced
    // password changes take effect without waiting for token expiry.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        isPlatformAdmin: true,
        mustChangePassword: true,
      },
    });
    if (!user) throw AppException.unauthorized('UNAUTHENTICATED', 'Authentication required');

    req.user = {
      sub: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
      mustChangePassword: user.mustChangePassword,
    };
    req.authSource = source;

    if (user.mustChangePassword && !this.isPasswordChangeAllowed(req.path)) {
      throw AppException.forbidden(
        'PASSWORD_CHANGE_REQUIRED',
        'Change your temporary password before continuing',
      );
    }
    return true;
  }

  private isPasswordChangeAllowed(path: string): boolean {
    return PASSWORD_CHANGE_ALLOWED_PATHS.some((allowed) => path === allowed);
  }
}
