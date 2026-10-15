import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '../../auth/permissions.js';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
/** La ruta exige un contexto activo y TODOS los permisos indicados. */
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export const ANY_PERMISSIONS_KEY = 'anyPermissions';
/**
 * La ruta exige un contexto activo y AL MENOS UNO de los permisos indicados. Se usa cuando el permiso
 * exacto depende del recurso (p. ej. invitar al Director exige `director:manage`; a otro rol,
 * `invitation:manage`); el servicio concreta la exigencia según el caso.
 */
export const RequireAnyPermission = (...permissions: PermissionCode[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);
