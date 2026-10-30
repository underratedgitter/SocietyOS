import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../common/prisma.service';
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
    if (!req.user) throw new UnauthorizedException('UNAUTHENTICATED');
    const flatId = paramStr(req.params.flatId);
    if (!flatId) throw new ForbiddenException('MISSING_FLAT_SCOPE');

    const flat = await this.prisma.flat.findUnique({
      where: { id: flatId },
      include: { building: { select: { societyId: true } } },
    });
    if (!flat) throw new ForbiddenException('FLAT_NOT_FOUND');

    const societyId = flat.building.societyId;
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId, userId: req.user.sub } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException('NOT_A_MEMBER');
    }
    req.membership = { societyId, role: membership.role };
    req.flat = { id: flat.id, societyId };

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles) {
      if (!roles.includes(membership.role)) {
        throw new ForbiddenException('FORBIDDEN_ROLE');
      }
    } else if (membership.role === 'RESIDENT') {
      const link = await this.prisma.residentFlatMembership.findUnique({
        where: { flatId_userId: { flatId: flat.id, userId: req.user.sub } },
      });
      if (!link) throw new ForbiddenException('NOT_A_FLAT_RESIDENT');
    }
    return true;
  }
}
