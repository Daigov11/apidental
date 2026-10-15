import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANY_PERMISSIONS_KEY, REQUIRED_PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import type { AppRequest } from './auth.types.js';

/** Guard global (se ejecuta después de JwtAuthGuard): aplica @RequirePermissions. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const any = this.reflector.getAllAndOverride<string[] | undefined>(ANY_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if ((!required || required.length === 0) && (!any || any.length === 0)) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const principal = req.principal;
    const needed = [...(required ?? []), ...(any ?? [])];
    if (!principal) throw new ForbiddenException('Acceso denegado');
    if (!principal.context) {
      req.denial = { reason: 'no_context', required: needed };
      throw new ForbiddenException('Seleccione una clínica/sede activa antes de usar este recurso');
    }
    const missingAll = required && !required.every((p) => principal.permissions.has(p));
    const missingAny = any && any.length > 0 && !any.some((p) => principal.permissions.has(p));
    if (missingAll || missingAny) {
      req.denial = { reason: 'missing_permission', required: needed };
      throw new ForbiddenException('No tiene permisos para esta operación');
    }
    return true;
  }
}
