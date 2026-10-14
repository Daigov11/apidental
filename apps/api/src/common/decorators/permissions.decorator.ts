import { SetMetadata } from '@nestjs/common';
import type { PermissionCode } from '../../auth/permissions.js';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
/** La ruta exige un contexto activo y TODOS los permisos indicados. */
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
