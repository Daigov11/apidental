import { loadEnvFile } from '../src/config/load-env-file.js';
import { PERMISSIONS, ROLE_DEFINITIONS } from '../src/auth/permissions.js';
import { hashPassword } from '../src/common/utils/password.js';
import { normalizeEmail } from '../src/common/utils/email.js';
import { createPrismaClient } from '../src/prisma/client.js';
import { assignmentKey } from '../src/users/assignment-key.js';

loadEnvFile();

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL no está definida');
const isProduction = process.env['NODE_ENV'] === 'production';
const db = createPrismaClient(databaseUrl, 2);

/** Sincroniza el catálogo de permisos y roles con el código (idempotente; seguro en producción). */
async function seedCatalog() {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await db.permission.upsert({ where: { code }, update: { description }, create: { code, description } });
  }
  const permissions = await db.permission.findMany();
  const idByCode = new Map(permissions.map((p) => [p.code, p.id]));

  for (const def of ROLE_DEFINITIONS) {
    const role = await db.role.upsert({
      where: { code: def.code },
      update: { name: def.name, scope: def.scope, description: def.description },
      create: { code: def.code, name: def.name, scope: def.scope, description: def.description },
    });
    const wanted = def.permissions.map((c) => idByCode.get(c)!);
    await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { notIn: wanted } } });
    for (const permissionId of wanted) {
      await db.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }
  console.log(`Catálogo sincronizado: ${permissions.length} permisos, ${ROLE_DEFINITIONS.length} roles.`);
}

/** Datos de desarrollo: Clínica Demo + Sede Demo + administrador desde variables de entorno. */
async function seedDemo() {
  let clinic = await db.clinic.findFirst({ where: { name: 'Clínica Demo' } });
  clinic ??= await db.clinic.create({
    data: { name: 'Clínica Demo', brandDisplayName: 'Clínica Demo', brandPrimaryColor: '#0e7490' },
  });
  let branch = await db.branch.findFirst({ where: { clinicId: clinic.id, name: 'Sede Demo' } });
  branch ??= await db.branch.create({
    data: { clinicId: clinic.id, name: 'Sede Demo', address: 'Lima, Perú' },
  });
  console.log(`Demo: clínica ${clinic.id}, sede ${branch.id}`);

  const email = process.env['SEED_ADMIN_EMAIL'];
  const password = process.env['SEED_ADMIN_PASSWORD'];
  if (!email || !password) {
    console.log('SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD no definidos: no se crea administrador de desarrollo.');
    return;
  }
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD debe tener al menos 12 caracteres');

  const normalized = normalizeEmail(email);
  let user = await db.user.findUnique({ where: { email: normalized } });
  user ??= await db.user.create({
    data: {
      email: normalized,
      passwordHash: await hashPassword(password),
      firstName: 'Admin',
      lastName: 'Desarrollo',
    },
  });

  for (const [roleCode, clinicId] of [
    ['PLATFORM_ADMIN', null],
    ['CLINIC_ADMIN', clinic.id],
  ] as const) {
    const role = await db.role.findUniqueOrThrow({ where: { code: roleCode } });
    const grant = { roleId: role.id, clinicId, branchId: null };
    await db.userAssignment.upsert({
      where: { assignmentKey: assignmentKey(user.id, grant) },
      update: { status: 'ACTIVE' },
      create: { userId: user.id, ...grant, assignmentKey: assignmentKey(user.id, grant) },
    });
  }
  console.log(`Administrador de desarrollo listo: ${normalized} (PLATFORM_ADMIN + CLINIC_ADMIN de Clínica Demo)`);
}

try {
  await seedCatalog();
  if (isProduction) {
    console.log('NODE_ENV=production: se omiten datos demo y el administrador de desarrollo.');
    console.log('Cree el primer administrador con: npm run db:create-admin -w apps/api');
  } else {
    await seedDemo();
  }
} finally {
  await db.$disconnect();
}
