/**
 * Catálogo de permisos y roles del RBAC inicial (fuente de verdad en código; el seed
 * lo sincroniza con las tablas permissions / roles / role_permissions).
 *
 * Limitaciones del RBAC inicial (documentadas a propósito):
 *  - Los permisos por rol son fijos (no editables por clínica todavía).
 *  - Existen permisos de fundación (clínicas, sedes, usuarios, auditoría) y de datos
 *    DEMOGRÁFICOS de pacientes (identificación, contacto, consentimientos y adjuntos
 *    administrativos). No hay permisos clínicos (historia, odontograma...): ningún rol los
 *    tiene, y esa decisión se debe tomar explícitamente cuando existan.
 *  - La política de acceso a pacientes es TEMPORAL hasta definir la historia clínica.
 *    El administrador de plataforma no tiene ningún permiso sobre datos de pacientes.
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
  // --- Pacientes (solo datos demográficos/administrativos; NO clínicos) ---
  'patient:read_basic': 'Ver identificación y contacto mínimos de pacientes',
  'patient:read': 'Ver la ficha demográfica completa, representantes y posibles duplicados',
  'patient:write': 'Crear y editar pacientes, identificadores, contactos y representantes',
  'consent:read': 'Ver consentimientos de pacientes',
  'consent:write': 'Registrar y revocar consentimientos',
  'attachment:read': 'Listar y descargar adjuntos administrativos de pacientes',
  'attachment:write': 'Cargar adjuntos administrativos y darlos de baja (lógica)',
} as const;

/** Permisos sobre datos de pacientes. El administrador de plataforma NO los tiene por diseño. */
export const PATIENT_DATA_PERMISSIONS = [
  'patient:read_basic',
  'patient:read',
  'patient:write',
  'consent:read',
  'consent:write',
  'attachment:read',
  'attachment:write',
] as const satisfies readonly PermissionCode[];

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

/** Todo lo de plataforma/fundación, sin ningún acceso a datos de pacientes. */
const PLATFORM_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) => !(PATIENT_DATA_PERMISSIONS as readonly string[]).includes(p),
);

// Política TEMPORAL de acceso a datos de pacientes, hasta definir los permisos de historia clínica.
const PATIENT_FULL_ACCESS: readonly PermissionCode[] = [...PATIENT_DATA_PERMISSIONS];
const PATIENT_READ_ONLY: readonly PermissionCode[] = [
  'patient:read_basic',
  'patient:read',
  'consent:read',
  'attachment:read',
];

const BASIC_READ: readonly PermissionCode[] = ['clinic:read', 'branch:read'];

export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    code: 'PLATFORM_ADMIN',
    name: 'Administrador de plataforma',
    scope: 'PLATFORM',
    description: 'Opera la plataforma. Sin acceso a datos clínicos por diseño.',
    permissions: PLATFORM_PERMISSIONS,
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
      ...PATIENT_FULL_ACCESS,
    ],
  },
  {
    code: 'RECEPTIONIST',
    name: 'Recepcionista',
    scope: 'CLINIC',
    description: 'Recepción y agenda (permisos de módulos futuros).',
    permissions: [...BASIC_READ, ...PATIENT_FULL_ACCESS],
  },
  {
    code: 'DENTIST',
    name: 'Odontólogo',
    scope: 'CLINIC',
    description: 'Atención clínica (permisos de módulos futuros).',
    permissions: [...BASIC_READ, ...PATIENT_READ_ONLY],
  },
  {
    code: 'CASHIER',
    name: 'Cajero',
    scope: 'CLINIC',
    description: 'Caja y cobros (permisos de módulos futuros).',
    permissions: [...BASIC_READ, 'patient:read_basic'],
  },
  {
    code: 'ASSISTANT',
    name: 'Asistente',
    scope: 'CLINIC',
    description: 'Apoyo clínico (permisos de módulos futuros).',
    permissions: [...BASIC_READ, ...PATIENT_READ_ONLY],
  },
];
