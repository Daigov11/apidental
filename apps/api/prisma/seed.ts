import { loadEnvFile } from '../src/config/load-env-file.js';
import { syncCatalog } from './catalog.js';
import { hashPassword } from '../src/common/utils/password.js';
import { normalizeEmail } from '../src/common/utils/email.js';
import { createPrismaClient } from '../src/prisma/client.js';
import { contactRow, identifierRow, prepareContacts, prepareIdentifier } from '../src/patients/patient-data.js';
import { toDateOnly } from '../src/patients/util/lima-date.js';
import { assignmentKey } from '../src/users/assignment-key.js';
import { seedDemoClinical } from './demo-data.js';
import { seedDemoAgenda } from './demo-agenda.js';
import { seedDemoExtra } from './demo-extra.js';

loadEnvFile();

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL no está definida');
const isProduction = process.env['NODE_ENV'] === 'production';
const db = createPrismaClient(databaseUrl, 2);

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
  await seedDemoPatients(clinic.id, user.id);

  // Equipo y atención clínica de demostración (ficticios). Contraseña: SEED_DEMO_PASSWORD o, si falta, la del administrador de desarrollo.
  const demoPassword = process.env['SEED_DEMO_PASSWORD'] ?? password;
  if (demoPassword.length < 12) throw new Error('SEED_DEMO_PASSWORD debe tener al menos 12 caracteres');
  const demo = await seedDemoClinical(db, { clinicId: clinic.id, branchId: branch.id, adminUserId: user.id, password: demoPassword });
  const agenda = await seedDemoAgenda(db, { clinicId: clinic.id, branchId: branch.id, dentistId: demo.users['dentist']!, receptionId: demo.users['reception']!, adminUserId: user.id });
  console.log(`Agenda demo (ficticia) lista: ${agenda.rooms} consultorios, ${agenda.services} servicios, ${agenda.appointments} citas nuevas.`);
  const extra = await seedDemoExtra(db, { clinicId: clinic.id, branchId: branch.id, dentistId: demo.users['dentist']!, receptionId: demo.users['reception']!, adminUserId: user.id });
  console.log(`Datos demo adicionales (ficticios) listos: ${JSON.stringify(extra)} (elementos nuevos en esta ejecución).`);
  console.log(`Atención clínica demo (ficticia) lista: ${Object.keys(demo.users).length} usuarios, ${Object.keys(demo.patients).length} pacientes con visita (cerrada/corregida, borrador y consentimiento faltante).`);
}

/**
 * Pacientes FICTICIOS de desarrollo (nombres "Demo", documentos 9000000x): cubren adulto,
 * menor con representante, un posible duplicado y consentimientos. Idempotente. Nunca en producción.
 */
async function seedDemoPatients(clinicId: string, authorId: string) {
  const author = authorId;
  const ensure = async (spec: {
    dni: string;
    firstName: string;
    lastName: string;
    secondLastName?: string;
    birthDate: string;
    sex: 'FEMALE' | 'MALE';
    mobile?: string;
    email?: string;
  }) => {
    const id = prepareIdentifier({ type: 'DNI' as never, number: spec.dni });
    const existing = await db.patientIdentifier.findFirst({
      where: { clinicId, type: id.type, number: id.number, status: 'ACTIVE' },
      select: { patientId: true },
    });
    if (existing) return existing.patientId;
    const contacts = prepareContacts([
      ...(spec.mobile ? [{ type: 'MOBILE' as never, value: spec.mobile }] : []),
      ...(spec.email ? [{ type: 'EMAIL' as never, value: spec.email }] : []),
    ]);
    return db.$transaction(async (tx) => {
      const p = await tx.patient.create({
        data: {
          clinicId,
          firstName: spec.firstName,
          lastName: spec.lastName,
          secondLastName: spec.secondLastName ?? null,
          birthDate: toDateOnly(spec.birthDate),
          sex: spec.sex,
          createdById: author,
        },
      });
      await tx.patientIdentifier.create({ data: identifierRow(clinicId, p.id, id, author) });
      for (const c of contacts) await tx.patientContact.create({ data: contactRow(clinicId, p.id, c, author) });
      return p.id;
    });
  };
  const consent = async (patientId: string, type: 'CLINICAL' | 'LOYALTY' | 'MARKETING', grantedBy: 'PATIENT' | 'GUARDIAN', guardianId?: string) => {
    const activeKey = `${patientId}|${type}`;
    if (await db.patientConsent.findUnique({ where: { activeKey } })) return;
    await db.patientConsent.create({
      data: {
        clinicId, patientId, type, activeKey, grantedBy, guardianId: guardianId ?? null,
        documentTitle: type === 'CLINICAL' ? 'Consentimiento informado (demo)' : `Autorización ${type} (demo)`,
        documentVersion: 'demo-1.0',
        grantedAt: new Date(),
        createdById: author,
      },
    });
  };

  const adult = await ensure({ dni: '90000001', firstName: 'Lucía', lastName: 'Demo', secondLastName: 'Adulta', birthDate: '1988-04-12', sex: 'FEMALE', mobile: '900000001', email: 'lucia.demo@example.test' });
  await consent(adult, 'CLINICAL', 'PATIENT');
  await consent(adult, 'LOYALTY', 'PATIENT');

  const child = await ensure({ dni: '90000002', firstName: 'Mateo', lastName: 'Demo', secondLastName: 'Menor', birthDate: '2017-09-30', sex: 'MALE' });
  const guardianExists = await db.guardian.findFirst({ where: { clinicId, identifierType: 'DNI', identifierNumber: '90000003' } });
  const guardian =
    guardianExists ??
    (await db.guardian.create({
      data: { clinicId, firstName: 'Carmen', lastName: 'Demo', secondLastName: 'Madre', identifierType: 'DNI', identifierNumber: '90000003', mobile: '900000003', createdById: author },
    }));
  if (!(await db.patientGuardian.findFirst({ where: { patientId: child, guardianId: guardian.id, status: 'ACTIVE' } }))) {
    await db.patientGuardian.create({
      data: { clinicId, patientId: child, guardianId: guardian.id, relationship: 'MOTHER', isPrimary: true, activeKey: `${child}|${guardian.id}`, createdById: author },
    });
  }
  await consent(child, 'CLINICAL', 'GUARDIAN', guardian.id);

  // Par de posibles duplicados (mismo nombre y nacimiento, distinto documento) para probar la advertencia.
  await ensure({ dni: '90000004', firstName: 'Jorge', lastName: 'Demo', secondLastName: 'Repetido', birthDate: '1975-01-20', sex: 'MALE', mobile: '900000004' });
  await ensure({ dni: '90000005', firstName: 'JORGE', lastName: 'DEMO', secondLastName: 'Repetido', birthDate: '1975-01-20', sex: 'MALE', mobile: '900000004' });
  // Paciente nueva (sin visitas previas) para mostrar el flujo cita → atención desde cero.
  const newcomer = await ensure({ dni: '90000006', firstName: 'Camila', lastName: 'Demo', secondLastName: 'Nueva', birthDate: '1995-06-18', sex: 'FEMALE', mobile: '900000006' });
  await consent(newcomer, 'CLINICAL', 'PATIENT');
  // Autorizaciones de fidelización y comunicaciones: permiten mostrar puntos y reseñas simulados en la demostración.
  await consent(newcomer, 'LOYALTY', 'PATIENT');
  await consent(newcomer, 'MARKETING', 'PATIENT');
  console.log('Pacientes demo (ficticios) listos: adulto, menor con representante y un par de posibles duplicados.');
}

try {
  const { permissions, roles } = await syncCatalog(db);
  console.log(`Catálogo sincronizado: ${permissions} permisos, ${roles} roles.`);
  if (isProduction) {
    console.log('NODE_ENV=production: se omiten datos demo y el administrador de desarrollo.');
    console.log('Cree el primer administrador con: npm run db:create-admin -w apps/api');
  } else {
    await seedDemo();
  }
} finally {
  await db.$disconnect();
}
