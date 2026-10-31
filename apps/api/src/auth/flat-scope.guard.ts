import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../common/prisma.service';
import { AppException } from '../common/app.exception';
import { paramStr } from '../common/params';
import { AuthedRequest } from './jwt-auth.guard';
import { ROLES_KEY } from './require-roles.decorator';

/**
 * Resolves :flatId routes to the flat + its society, checks membership and,
 * for RESIDENTs, requires an actual resident-flat link.
 */
@Injectable()
export class FlatScopeGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw AppException.unauthorized('UNAUTHENTICATED', 'Authentication required');
    const flatId = paramStr(req.params.flatId);
    if (!flatId) throw AppException.forbidden('MISSING_FLAT_SCOPE', 'Flat scope is required');

    const flat = await this.prisma.flat.findUnique({
      where: { id: flatId },
      include: { building: { select: { societyId: true } } },
    });
    if (!flat) throw AppException.forbidden('FLAT_NOT_FOUND', 'Flat not found in your society');

    const societyId = flat.building.societyId;
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId, userId: req.user.sub } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw AppException.forbidden('NOT_A_MEMBER', 'You are not an active member of this society');
    }
    req.membership = { societyId, role: membership.role };
    req.flat = { id: flat.id, societyId };

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles) {
      if (!roles.includes(membership.role)) {
        throw AppException.forbidden('FORBIDDEN_ROLE', 'Your role cannot perform this action');
      }
    } else if (membership.role === 'RESIDENT') {
      const link = await this.prisma.residentFlatMembership.findFirst({
        where: { flatId: flat.id, userId: req.user.sub, endedAt: null },
      });
      if (!link) throw AppException.forbidden('NOT_A_FLAT_RESIDENT', 'You are not a resident of this flat');
    }
    return true;
  }
}
