/**
 * Catálogo de permisos y roles del RBAC inicial (fuente de verdad en código; el seed
 * lo sincroniza con las tablas permissions / roles / role_permissions).
 *
 * Limitaciones del RBAC inicial (documentadas a propósito):
 *  - Los permisos por rol son fijos (no editables por clínica todavía).
 *  - Existen permisos de fundación (clínicas, sedes, usuarios, auditoría), de datos
 *    DEMOGRÁFICOS de pacientes (identificación, contacto, consentimientos y adjuntos
 *    administrativos) y, desde 3.1, de acceso CLÍNICO (clinical:*) y de asignación asistencial.
 *  - Un permiso clínico por sí solo NO da acceso a ningún paciente: además hace falta relación
 *    asistencial vigente (odontólogo, asistente) o una autorización de lectura justificada
 *    (clinical:read_all, solo Director Clínico). Ver ClinicalAccessService.
 *  - El administrador de plataforma no tiene ningún permiso sobre datos de pacientes ni clínicos.
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
  // --- Aprovisionamiento por invitación (sub-incremento 3.0) ---
  'invitation:read': 'Ver invitaciones dentro del contexto activo',
  'invitation:manage': 'Crear, reenviar y revocar invitaciones (no incluye al Director Clínico)',
  'provisioning:record': 'Registrar la autorización formal de aprovisionamiento de la clínica',
  'provisioning:read': 'Ver los registros formales de aprovisionamiento',
  'director:manage': 'Invitar y revocar al Director Clínico (solo un Director vigente)',
  // --- Pacientes (solo datos demográficos/administrativos; NO clínicos) ---
  'patient:read_basic': 'Ver identificación y contacto mínimos de pacientes',
  'patient:read': 'Ver la ficha demográfica completa, representantes y posibles duplicados',
  'patient:write': 'Crear y editar pacientes, identificadores, contactos y representantes',
  'consent:read': 'Ver consentimientos de pacientes',
  'consent:write': 'Registrar y revocar consentimientos',
  'attachment:read': 'Listar y descargar adjuntos administrativos de pacientes',
  'attachment:write': 'Cargar adjuntos administrativos y darlos de baja (lógica)',
  // --- Acceso clínico (sub-incremento 3.1). Ninguno da acceso por sí solo: ver ClinicalAccessService ---
  'clinical:read': 'Leer información clínica de pacientes con relación asistencial vigente',
  'clinical:write': 'Registrar información clínica de pacientes con relación asistencial vigente',
  'clinical:read_limited': 'Ver la vista de apoyo (alertas y datos de apoyo, sin diagnósticos ni evoluciones)',
  'clinical:view': 'Ver (solo lectura, sin editar) la información clínica de los pacientes de la clínica',
  'clinical:read_all':
    'Leer (nunca escribir) información clínica de un paciente de la clínica con justificación, reautenticación y auditoría previa (solo Director Clínico)',
  // --- Catálogo de procedimientos de la clínica (3.3). Configuración administrativa, no datos de pacientes ---
  'procedure:read': 'Ver el catálogo de procedimientos de la clínica',
  'procedure:manage': 'Configurar el catálogo de procedimientos de la clínica (incluye si requieren consentimiento clínico)',
  // --- Agenda y citas (4.0). Administrativos: no dan acceso a datos clínicos ---
  'appointment:read': 'Ver la agenda y las citas de la clínica',
  'appointment:manage': 'Crear, confirmar, reprogramar, cancelar y marcar ausencia en citas; bloquear horarios',
  'appointment:attend': 'Iniciar la atención de las propias citas (abre la visita clínica; exige además permisos clínicos)',
  'agenda:manage': 'Configurar consultorios, especialidades, servicios, horarios y odontólogos de la agenda',
  // --- Cobros, comprobantes y fidelización (4.1, solo con INTEGRATIONS_MODE=mock). Administrativos: sin datos clínicos ---
  'charge:read': 'Ver cobros de la clínica',
  'charge:manage': 'Registrar cobros y pagos de atenciones',
  'billing:read': 'Ver comprobantes, la cola de integraciones y su conciliación',
  'billing:manage': 'Emitir, reintentar y conciliar comprobantes; procesar la cola de integraciones',
  'loyalty:read': 'Ver saldo de fidelización, resumen NFC y reseñas de pacientes con autorización',
  'loyalty:manage': 'Canjear puntos de fidelización',
  'care:assign': 'Asignar y revocar la relación asistencial paciente–odontólogo (acto administrativo, no clínico)',
} as const;

/** Permisos de acceso clínico. La plataforma no los tiene por diseño. */
export const CLINICAL_PERMISSIONS = [
  'clinical:read',
  'clinical:write',
  'clinical:read_limited',
  'clinical:view',
  'clinical:read_all',
] as const satisfies readonly PermissionCode[];

/**
 * Permisos de atención que NO confieren acceso por sí mismos (exigen además relación asistencial vigente):
 * por eso un administrador puede invitar o asignar a un odontólogo/asistente aunque no los posea, sin que
 * ello sea una escalada. `clinical:read_all` NUNCA está aquí: solo se obtiene con el rol Director Clínico.
 */
export const CARE_ATTENDANCE_PERMISSIONS = [
  'clinical:read',
  'clinical:write',
  'clinical:read_limited',
  'clinical:view',
  'appointment:attend',
] as const satisfies readonly PermissionCode[];

/** Único rol que puede tener `clinical:read_all` (lo impide también un trigger de la base de datos). */
export const READ_ALL_ROLE_CODE = 'CLINICAL_DIRECTOR';

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

/**
 * Gobierno que corresponde a la clínica y NO a la plataforma: el aprovisionamiento formal y la
 * designación del Director Clínico. La plataforma nunca los tiene, para que no pueda designar
 * por sí sola a quien tendrá autoridad clínica.
 */
export const CLINIC_GOVERNANCE_PERMISSIONS = [
  'provisioning:record',
  'provisioning:read',
  'director:manage',
] as const satisfies readonly PermissionCode[];

/** Todo lo de plataforma/fundación, sin datos de pacientes ni gobierno clínico de la clínica. */
const PLATFORM_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) =>
    !(PATIENT_DATA_PERMISSIONS as readonly string[]).includes(p) &&
    !(CLINICAL_PERMISSIONS as readonly string[]).includes(p) &&
    p !== 'care:assign' &&
    !p.startsWith('procedure:') &&
    !p.startsWith('appointment:') &&
    !p.startsWith('agenda:') &&
    !p.startsWith('charge:') &&
    !p.startsWith('billing:') &&
    !p.startsWith('loyalty:') &&
    !(CLINIC_GOVERNANCE_PERMISSIONS as readonly string[]).includes(p),
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
      'invitation:read',
      'invitation:manage',
      'provisioning:record',
      'provisioning:read',
      'care:assign',
      'procedure:read',
      'procedure:manage',
      'appointment:read',
      'appointment:manage',
      'agenda:manage',
      // Anti-escalada: el administrador debe poder otorgar el rol de Cajero, así que tiene todos sus permisos.
      'charge:read',
      'charge:manage',
      'billing:read',
      'billing:manage',
      'loyalty:read',
      'loyalty:manage',
      ...PATIENT_FULL_ACCESS,
    ],
  },
  {
    // Autoridad clínica de la clínica. clinical:read_all es lectura excepcional de UN paciente por vez, con
    // justificación, reautenticación y auditoría previa; no incluye clinical:write.
    code: 'CLINICAL_DIRECTOR',
    name: 'Director Clínico',
    scope: 'CLINIC',
    description: 'Autoridad clínica de la clínica. Se designa solo por invitación formal.',
    permissions: [
      ...BASIC_READ,
      'role:read',
      'invitation:read',
      'provisioning:read',
      'director:manage',
      'patient:read_basic',
      'patient:read',
      'consent:read',
      'attachment:read',
      'clinical:read_all',
      'care:assign',
      'procedure:read',
      'procedure:manage',
      'appointment:read',
    ],
  },
  {
    code: 'RECEPTIONIST',
    name: 'Recepcionista',
    scope: 'CLINIC',
    description: 'Recepción y agenda. Ve (solo lectura) la información clínica; no la edita.',
    permissions: [...BASIC_READ, ...PATIENT_FULL_ACCESS, 'care:assign', 'clinical:view', 'appointment:read', 'appointment:manage', 'charge:read', 'charge:manage', 'billing:read', 'loyalty:read'],
  },
  {
    code: 'DENTIST',
    name: 'Odontólogo',
    scope: 'CLINIC',
    description: 'Atención clínica de los pacientes con los que tiene relación asistencial vigente.',
    permissions: [...BASIC_READ, ...PATIENT_READ_ONLY, 'clinical:read', 'clinical:write', 'procedure:read', 'appointment:read', 'appointment:attend'],
  },
  {
    code: 'CASHIER',
    name: 'Cajero',
    scope: 'CLINIC',
    description: 'Caja, cobros y comprobantes.',
    permissions: [...BASIC_READ, 'patient:read_basic', 'appointment:read', 'charge:read', 'charge:manage', 'billing:read', 'billing:manage', 'loyalty:read', 'loyalty:manage'],
  },
  {
    code: 'ASSISTANT',
    name: 'Asistente',
    scope: 'CLINIC',
    description: 'Apoyo clínico: vista limitada (alertas y datos de apoyo) de los pacientes en atención.',
    permissions: [...BASIC_READ, ...PATIENT_READ_ONLY, 'clinical:read_limited', 'appointment:read'],
  },
];
