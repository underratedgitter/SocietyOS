import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../common/prisma.service';
import { paramStr } from '../common/params';
import { AuthedRequest } from './jwt-auth.guard';
import { ROLES_KEY } from './require-roles.decorator';

/**
 * Resolves the caller's membership for :societyId routes, attaches it to the
 * request as tenant context, and enforces @RequireRoles when present.
 * Tenant authorization is always derived server-side from the path + JWT.
 */
@Injectable()
export class SocietyScopeGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new UnauthorizedException('UNAUTHENTICATED');
    const societyId = paramStr(req.params.societyId);
    if (!societyId) throw new ForbiddenException('MISSING_SOCIETY_SCOPE');

    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId, userId: req.user.sub } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException('NOT_A_MEMBER', 'You are not an active member of this society');
    }
    req.membership = { societyId: membership.societyId, role: membership.role };

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && !roles.includes(membership.role)) {
      throw new ForbiddenException('FORBIDDEN_ROLE', 'Your role cannot perform this action');
    }
    return true;
  }
}
