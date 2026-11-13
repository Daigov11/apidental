import { loadEnvFile } from '../src/config/load-env-file.js';
import { hashPassword } from '../src/common/utils/password.js';
import { createPrismaClient } from '../src/prisma/client.js';
import { assignmentKey } from '../src/users/assignment-key.js';

/**
 * SOLO para instalaciones de DEMOSTRACIÓN (sin Apiworking): deja las cuentas demo con un correo corto y la clave 123456, conservando
 * sus datos (citas, atenciones, roles). Además crea admin@demo.pe como administrador de la clínica demo.
 *   npm run db:demo-simple-logins -w apps/api
 * Se niega a correr en una instalación con Apiworking (APIWORKING_AUTHZ_EXPECTED_DATABASE definida) o sin datos demo.
 */
loadEnvFile();

const PASSWORD = '123456';
/** Correo demo actual -> correo corto. */
const RENAMES: [string, string][] = [
  ['odontologa.demo@apidental.test', 'odontologo@demo.pe'],
  ['odontologo2.demo@apidental.test', 'odontologo2@demo.pe'],
  ['odontologo3.demo@apidental.test', 'odontologo3@demo.pe'],
  ['odontologo4.demo@apidental.test', 'odontologo4@demo.pe'],
  ['odontologo5.demo@apidental.test', 'odontologo5@demo.pe'],
  ['cajero.demo@apidental.test', 'cajero@demo.pe'],
];
const ADMIN_EMAIL = 'admin@demo.pe';

if (process.env['APIWORKING_AUTHZ_EXPECTED_DATABASE']) throw new Error('Esta instalación usa Apiworking: las cuentas demo con clave 123456 solo se crean en las demos');
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL no está definida');

const db = createPrismaClient(databaseUrl, 2);
try {
  const cashierUser = await db.user.findFirst({ where: { email: { in: ['cajero.demo@apidental.test', 'cajero@demo.pe'] } }, select: { id: true } });
  if (!cashierUser) throw new Error('No hay datos demo en esta base (falta la cuenta del cajero demo)');
  const demoAssignment = await db.userAssignment.findFirst({ where: { userId: cashierUser.id, clinicId: { not: null } }, select: { clinicId: true } });
  const clinicId = demoAssignment?.clinicId;
  if (!clinicId) throw new Error('El cajero demo no tiene clínica asignada');
  const passwordHash = await hashPassword(PASSWORD);
  const done: string[] = [];

  for (const [from, to] of RENAMES) {
    const user = (await db.user.findUnique({ where: { email: to } })) ?? (await db.user.findUnique({ where: { email: from } }));
    if (!user) continue;
    await db.user.update({ where: { id: user.id }, data: { email: to, passwordHash, status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null } });
    done.push(to);
  }

  // Administrador demo de la clínica (nuevo; no se toca el administrador real de la instalación).
  const role = await db.role.findUniqueOrThrow({ where: { code: 'CLINIC_ADMIN' } });
  const admin = (await db.user.findUnique({ where: { email: ADMIN_EMAIL } }))
    ?? (await db.user.create({ data: { email: ADMIN_EMAIL, passwordHash, firstName: 'Admin', lastName: 'Demo (administración)' } }));
  await db.user.update({ where: { id: admin.id }, data: { passwordHash, status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null } });
  const key = assignmentKey(admin.id, { roleId: role.id, clinicId, branchId: null });
  await db.userAssignment.upsert({ where: { assignmentKey: key }, create: { userId: admin.id, roleId: role.id, clinicId, branchId: null, assignmentKey: key }, update: { status: 'ACTIVE' } });
  done.push(ADMIN_EMAIL);

  await db.auditLog.create({ data: { action: 'DEMO_LOGINS_SIMPLIFIED', entity: 'User', clinicId, summary: { accounts: done.length } } });
  console.log(`Listo. Cuentas demo (clave ${PASSWORD}):`);
  for (const e of done) console.log(`  ${e}`);
} finally {
  await db.$disconnect();
}
