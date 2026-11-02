import { parseArgs } from 'node:util';
import { loadEnvFile } from '../src/config/load-env-file.js';
import { normalizeEmail } from '../src/common/utils/email.js';
import { createPrismaClient } from '../src/prisma/client.js';
import { assignmentKey } from '../src/users/assignment-key.js';

/**
 * Asigna un rol de clínica a un usuario que YA ingresó una vez (el usuario local de una cuenta de Apiworking nace sin roles).
 * Es el arranque seguro del primer administrador de la clínica; luego él puede asignar roles desde la API.
 *   npm run db:grant-role -w apps/api -- --username gina --role CLINIC_ADMIN [--clinic <id>] [--branch <nombre>]
 *   npm run db:grant-role -w apps/api -- --email correo@clinica.pe --role DENTIST
 * Los roles de plataforma NO se asignan aquí (use db:create-admin).
 */
loadEnvFile();

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
    clinic: { type: 'string' },
    branch: { type: 'string' },
  },
});
const usage = 'Uso: npm run db:grant-role -w apps/api -- (--username <usuario de Apiworking> | --email <correo>) --role <CODIGO> [--clinic <id>] [--branch <nombre>]';
if ((!values.username && !values.email) || (values.username && values.email) || !values.role) throw new Error(usage);
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL no está definida');

const db = createPrismaClient(databaseUrl, 2);
try {
  let userId: string | undefined;
  let label: string;
  if (values.username) {
    const tenant = process.env['APIWORKING_AUTHZ_EXPECTED_DATABASE'];
    if (!tenant) throw new Error('APIWORKING_AUTHZ_EXPECTED_DATABASE no está definida: no se sabe de qué tenant es el usuario');
    const identity = await db.externalIdentity.findFirst({ where: { provider: 'APIWORKING', tenant, externalUsername: values.username } });
    userId = identity?.userId;
    label = `${values.username} (Apiworking)`;
  } else {
    label = normalizeEmail(values.email!);
    userId = (await db.user.findUnique({ where: { email: label } }))?.id;
  }
  if (!userId) throw new Error(`No existe el usuario ${label}. Si es una cuenta de Apiworking, debe ingresar al panel al menos una vez.`);

  const role = await db.role.findUnique({ where: { code: values.role! } });
  if (!role) throw new Error(`No existe el rol ${values.role}. Ejecute el seed si el catálogo está vacío.`);
  if (role.scope !== 'CLINIC') throw new Error('Solo se asignan roles de clínica con este comando (para plataforma use db:create-admin)');

  const clinics = await db.clinic.findMany({ where: values.clinic ? { id: values.clinic } : {}, select: { id: true, name: true } });
  if (clinics.length !== 1) throw new Error(values.clinic ? 'No existe esa clínica' : `Hay ${clinics.length} clínicas: indique cuál con --clinic <id>`);
  const clinic = clinics[0]!;
  let branchId: string | null = null;
  if (values.branch) {
    const branch = await db.branch.findUnique({ where: { clinicId_name: { clinicId: clinic.id, name: values.branch } } });
    if (!branch) throw new Error(`No existe la sede «${values.branch}» en ${clinic.name}`);
    branchId = branch.id;
  }

  const grant = { roleId: role.id, clinicId: clinic.id, branchId };
  const key = assignmentKey(userId, grant);
  const assignment = await db.userAssignment.upsert({
    where: { assignmentKey: key },
    update: { status: 'ACTIVE' },
    create: { userId, ...grant, assignmentKey: key },
  });
  await db.auditLog.create({
    data: {
      action: 'ASSIGNMENT_CREATED', entity: 'UserAssignment', entityId: assignment.id, userId, clinicId: clinic.id, branchId,
      summary: { role: role.code, via: 'grant-role' },
    },
  });
  console.log(`Listo: ${label} tiene el rol ${role.code} en ${clinic.name}${branchId ? ` (sede ${values.branch})` : ''}.`);
} finally {
  await db.$disconnect();
}
