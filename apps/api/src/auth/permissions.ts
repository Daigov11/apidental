/**
 * Catálogo de permisos y roles del RBAC inicial (fuente de verdad en código; el seed
 * lo sincroniza con las tablas permissions / roles / role_permissions).
 *
 * Limitaciones del RBAC inicial (documentadas a propósito):
 *  - Los permisos por rol son fijos (no editables por clínica todavía).
 *  - Solo existen permisos de fundación (clínicas, sedes, usuarios, auditoría). No hay
 *    permisos clínicos: ningún rol, incluido el administrador de plataforma, tiene acceso
 *    a datos clínicos, y esa decisión se debe tomar explícitamente cuando existan.
 *  - Un permiso se evalúa solo dentro del contexto activo (clínica/sede) seleccionado.
 */
export const PERMISSIONS = {
  'clinic:read': 'Ver clínicas dentro del contexto activo',
  'clinic:manage': 'Crear y administrar clínicas (solo plataforma)',
  'branch:read': 'Ver sedes dentro del contexto activo',
  'branch:manage': 'Crear y administrar sedes',
  'user:read': 'Ver usuarios dentro del contexto activo',
  'user:manage': 'Crear y administrar usuarios',
  'role:read': 'Ver roles y sus permisos',
  'assignment:manage': 'Asignar y revocar roles por clínica y sede',
  'audit:read': 'Consultar la auditoría dentro del contexto activo',
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;

export type RoleScopeCode = 'PLATFORM' | 'CLINIC';

export interface RoleDefinition {
  code: string;
  name: string;
  scope: RoleScopeCode;
  description: string;
  permissions: readonly PermissionCode[];
}

const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionCode[];

const BASIC_READ: readonly PermissionCode[] = ['clinic:read', 'branch:read'];

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    code: 'PLATFORM_ADMIN',
    name: 'Administrador de plataforma',
    scope: 'PLATFORM',
    description: 'Opera la plataforma. Sin acceso a datos clínicos por diseño.',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'CLINIC_ADMIN',
    name: 'Administrador de clínica',
    scope: 'CLINIC',
    description: 'Administra usuarios, sedes y asignaciones de su clínica.',
    permissions: [
      'clinic:read',
      'branch:read',
      'branch:manage',
      'user:read',
      'user:manage',
      'role:read',
      'assignment:manage',
      'audit:read',
    ],
  },
  {
    code: 'RECEPTIONIST',
    name: 'Recepcionista',
    scope: 'CLINIC',
    description: 'Recepción y agenda (permisos de módulos futuros).',
    permissions: BASIC_READ,
  },
  {
    code: 'DENTIST',
    name: 'Odontólogo',
    scope: 'CLINIC',
    description: 'Atención clínica (permisos de módulos futuros).',
    permissions: BASIC_READ,
  },
  {
    code: 'CASHIER',
    name: 'Cajero',
    scope: 'CLINIC',
    description: 'Caja y cobros (permisos de módulos futuros).',
    permissions: BASIC_READ,
  },
  {
    code: 'ASSISTANT',
    name: 'Asistente',
    scope: 'CLINIC',
    description: 'Apoyo clínico (permisos de módulos futuros).',
    permissions: BASIC_READ,
  },
];
