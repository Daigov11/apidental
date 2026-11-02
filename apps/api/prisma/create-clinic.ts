import { parseArgs } from 'node:util';
import { loadEnvFile } from '../src/config/load-env-file.js';
import { createPrismaClient } from '../src/prisma/client.js';

/**
 * Crea (o reutiliza) la clínica de una instalación y su sede principal. Es el arranque de una BD nueva por cliente:
 *   npm run db:create-clinic -w apps/api -- --name "Dra. Gina Paredes Yauri" --ruc 10074654016
 * Imprime el id de la clínica (para PUBLIC_BOOKING_CLINIC_ID). Idempotente: si ya existe una clínica con ese RUC, la reutiliza.
 */
loadEnvFile();

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    ruc: { type: 'string' },
    branch: { type: 'string', default: 'Sede principal' },
  },
});
const name = values.name?.trim();
const ruc = values.ruc?.trim();
if (!name || (ruc && !/^\d{11}$/.test(ruc))) {
  throw new Error('Uso: npm run db:create-clinic -w apps/api -- --name "Nombre de la clínica" [--ruc 11 dígitos] [--branch "Sede principal"]');
}
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL no está definida');

const db = createPrismaClient(databaseUrl, 2);
try {
  const existing = ruc ? await db.clinic.findUnique({ where: { ruc } }) : null;
  const clinic = existing ?? (await db.clinic.create({ data: { name, legalName: name, ruc: ruc ?? null } }));
  const branchName = values.branch!.trim();
  const branch =
    (await db.branch.findUnique({ where: { clinicId_name: { clinicId: clinic.id, name: branchName } } })) ??
    (await db.branch.create({ data: { clinicId: clinic.id, name: branchName } }));
  if (!existing) {
    await db.auditLog.create({
      data: { action: 'CLINIC_CREATED', entity: 'Clinic', entityId: clinic.id, clinicId: clinic.id, summary: { via: 'create-clinic', ruc: ruc ?? null } },
    });
  }
  console.log(`${existing ? 'Clínica existente' : 'Clínica creada'}: ${clinic.name}`);
  console.log(`  clinicId: ${clinic.id}   (PUBLIC_BOOKING_CLINIC_ID)`);
  console.log(`  sede:     ${branch.name} (${branch.id})`);
} finally {
  await db.$disconnect();
}
