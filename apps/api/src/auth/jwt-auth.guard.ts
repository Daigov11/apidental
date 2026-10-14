import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { AccessService } from './access.service.js';
import type { AppRequest } from './auth.types.js';
import { TokenService } from './token.service.js';

/**
 * Guard global: exige JWT válido salvo en rutas @Public(). En cada solicitud vuelve a
 * leer el usuario y sus asignaciones, de modo que desactivar un usuario o revocar una
 * asignación surte efecto de inmediato (no hay que esperar a que expire el token).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    @Inject(PRISMA) private readonly db: PrismaDb,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Se requiere autenticación');

    const payload = await this.tokens.verify(token);
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, firstName: true, lastName: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Token inválido o expirado');

    let roles: string[] = [];
    let permissions = new Set<string>();
    if (payload.ctx) {
      const resolved = await this.access.resolve(user.id, payload.ctx);
      if (!resolved) throw new ForbiddenException('El contexto activo ya no es válido; seleccione uno nuevo');
      roles = resolved.roles;
      permissions = resolved.permissions;
    }

    req.principal = {
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
      context: payload.ctx ?? null,
      roles,
      permissions,
    };
    return true;
  }
}
