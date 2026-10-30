import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

export interface JwtUser {
  sub: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export interface AuthedRequest extends Request {
  user?: JwtUser;
  membership?: { societyId: string; role: string };
  flat?: { id: string; societyId: string };
  device?: { id: string; deviceUid: string; societyId: string; name: string };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    const token = header.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET || 'dev-only-access-secret-change-in-prod') as jwt.JwtPayload;
      req.user = {
        sub: payload.sub as string,
        email: payload.email as string,
        name: payload.name as string,
        isPlatformAdmin: !!payload.isPlatformAdmin,
      };
      return true;
    } catch {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
  }
}
