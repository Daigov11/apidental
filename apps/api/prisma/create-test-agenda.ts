import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadEnvFile } from '../src/config/load-env-file.js';
import { hashPassword } from '../src/common/utils/password.js';
import { createPrismaClient } from '../src/prisma/client.js';
import { assignmentKey } from '../src/users/assignment-key.js';

/**
 * Datos de PRUEBA para agendar citas en una clínica real: especialidad, consultorios, servicios, dos odontólogos y sus horarios.
 * Todo lleva «(prueba)» en el nombre para reconocerlo y desactivarlo después. Es idempotente (no duplica).
 * Los odontólogos de prueba NO pueden ingresar (su contraseña es aleatoria y no se guarda); sirven para agendar y ver la agenda.
 *   npm run db:create-test-agenda -w apps/api -- --clinic <id> --domain angeldent [--branch "Sede principal"]
 */
loadEnvFile();

const { values } = parseArgs({ options: { clinic: { type: 'string' }, domain: { type: 'string' }, branch: { type: 'string', default: 'Sede principal' } } });
if (!values.clinic || !values.domain || !/^[a-z][a-z0-9]{1,30}$/.test(values.domain)) {
  throw new Error('Uso: npm run db:create-test-agenda -w apps/api -- --clinic <id> --domain <instancia> [--branch "Sede principal"]');
}
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL no está definida');

const SPECIALTY = 'Odontología general (prueba)';
const ROOMS = ['Consultorio 1 (prueba)', 'Consultorio 2 (prueba)'];
const SERVICES = [
  { name: 'Consulta y diagnóstico (prueba)', minutes: 30, price: 5_000 },
  { name: 'Limpieza dental (prueba)', minutes: 45, price: 8_000 },
  { name: 'Restauración con resina (prueba)', minutes: 60, price: 12_000 },
  { name: 'Extracción simple (prueba)', minutes: 45, price: 10_000 },
  { name: 'Control (prueba)', minutes: 30, price: 4_000 },
];
const DENTISTS = [
  { slug: 'odontologo1', first: 'Odontólogo', last: 'Prueba Uno', room: 0, windows: [[8 * 60, 13 * 60], [14 * 60, 18 * 60]] },
  { slug: 'odontologo2', first: 'Odontóloga', last: 'Prueba Dos', room: 1, windows: [[9 * 60, 13 * 60], [15 * 60, 19 * 60]] },
] as const;
const WEEKDAYS = [1, 2, 3, 4, 5, 6]; // lunes a sábado

const db = createPrismaClient(databaseUrl, 2);
try {
  const clinic = await db.clinic.findUnique({ where: { id: values.clinic } });
  if (!clinic) throw new Error('No existe esa clínica');
  const branch = await db.branch.findUnique({ where: { clinicId_name: { clinicId: clinic.id, name: values.branch! } } });
  if (!branch) throw new Error(`No existe la sede «${values.branch}» en ${clinic.name}`);
  const role = await db.role.findUnique({ where: { code: 'DENTIST' } });
  if (!role) throw new Error('No existe el rol DENTIST: ejecute el seed');
  const clinicId = clinic.id;
  const branchId = branch.id;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  const made: string[] = [];

  const specialty = (await db.specialty.findUnique({ where: { clinicId_name: { clinicId, name: SPECIALTY } } })) ?? (made.push('especialidad'), await db.specialty.create({ data: { clinicId, name: SPECIALTY } }));
  const rooms: string[] = [];
  for (const name of ROOMS) {
    const r = (await db.room.findUnique({ where: { branchId_name: { branchId, name } } })) ?? (made.push(name), await db.room.create({ data: { clinicId, branchId, name } }));
    rooms.push(r.id);
  }
  for (const s of SERVICES) {
    if (await db.agendaService.findUnique({ where: { clinicId_name: { clinicId, name: s.name } } })) continue;
    await db.agendaService.create({ data: { clinicId, name: s.name, durationMinutes: s.minutes, priceCents: s.price, specialtyId: specialty.id } });
    made.push(s.name);
  }
  for (const d of DENTISTS) {
    const email = `prueba.${d.slug}@${values.domain}.invalid`;
    let user = await db.user.findUnique({ where: { email } });
    if (!user) {
      // Contraseña aleatoria que no se guarda en ningún sitio: la cuenta existe para agendar, no para ingresar.
      user = await db.user.create({ data: { email, passwordHash: await hashPassword(randomBytes(32).toString('hex')), firstName: d.first, lastName: `${d.last} (prueba)` } });
      made.push(`${d.first} ${d.last}`);
    }
    const grant = { roleId: role.id, clinicId, branchId };
    const key = assignmentKey(user.id, grant);
    await db.userAssignment.upsert({ where: { assignmentKey: key }, update: { status: 'ACTIVE' }, create: { userId: user.id, ...grant, assignmentKey: key } });
    await db.dentistSpecialty.upsert({ where: { userId_specialtyId: { userId: user.id, specialtyId: specialty.id } }, update: {}, create: { clinicId, userId: user.id, specialtyId: specialty.id } });
    if ((await db.scheduleRule.count({ where: { clinicId, dentistUserId: user.id, status: 'ACTIVE' } })) === 0) {
      await db.scheduleRule.createMany({
        data: WEEKDAYS.flatMap((weekday) => d.windows.map(([startMinute, endMinute]) => ({
          clinicId, branchId, dentistUserId: user!.id, roomId: rooms[d.room]!, weekday, startMinute, endMinute, validFrom: new Date(`${today}T00:00:00.000Z`), createdById: user!.id,
        }))),
      });
      made.push(`horario de ${d.first} ${d.last}`);
    }
  }
  await db.auditLog.create({ data: { action: 'TEST_AGENDA_CREATED', entity: 'Clinic', entityId: clinicId, clinicId, branchId, summary: { via: 'create-test-agenda', created: made.length } } });
  console.log(`Agenda de prueba en ${clinic.name} (${branch.name}): ${made.length ? made.join(', ') : 'ya existía, no se creó nada'}.`);
} finally {
  await db.$disconnect();
}
