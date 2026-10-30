import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthedRequest, JwtUser } from './jwt-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser | undefined => {
    return (ctx.switchToHttp().getRequest<AuthedRequest>()).user;
  },
);
