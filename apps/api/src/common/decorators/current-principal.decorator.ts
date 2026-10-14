import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AppRequest, AuthPrincipal } from '../../auth/auth.types.js';

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const principal = ctx.switchToHttp().getRequest<AppRequest>().principal;
    if (!principal) throw new UnauthorizedException('No autenticado');
    return principal;
  },
);
