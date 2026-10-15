import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard.js';
import type { AuthPrincipal } from './auth.types.js';

function ctxWith(principal: AuthPrincipal | undefined): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
}

const principal = (permissions: string[], withContext = true): AuthPrincipal => ({
  user: { id: 'u', email: 'u@x.pe', firstName: 'U', lastName: 'X' },
  sessionId: 's',
  context: withContext ? { clinicId: 'c', branchId: null } : null,
  roles: ['R'],
  permissions: new Set(permissions),
});

function guardRequiring(required: string[] | undefined) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
  return new PermissionsGuard(reflector);
}

describe('PermissionsGuard', () => {
  it('permite rutas sin permisos requeridos', () => {
    expect(guardRequiring(undefined).canActivate(ctxWith(principal([])))).toBe(true);
  });

  it('permite cuando el principal tiene todos los permisos', () => {
    const g = guardRequiring(['branch:read', 'clinic:read']);
    expect(g.canActivate(ctxWith(principal(['branch:read', 'clinic:read', 'x'])))).toBe(true);
  });

  it('deniega si falta alguno', () => {
    const g = guardRequiring(['branch:read', 'branch:manage']);
    expect(() => g.canActivate(ctxWith(principal(['branch:read'])))).toThrow(ForbiddenException);
  });

  it('deniega sin contexto activo aunque el principal exista', () => {
    const g = guardRequiring(['branch:read']);
    expect(() => g.canActivate(ctxWith(principal(['branch:read'], false)))).toThrow(/clínica\/sede activa/);
  });

  it('deniega si no hay principal', () => {
    expect(() => guardRequiring(['branch:read']).canActivate(ctxWith(undefined))).toThrow(ForbiddenException);
  });
});
