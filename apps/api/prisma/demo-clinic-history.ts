import { randomUUID } from 'node:crypto';
import { addDays, addMinutes, limaToUtc, slotStarts, utcToLima, weekdayOfDate } from '../src/agenda/agenda-time.js';
import { hashPassword } from '../src/common/utils/password.js';
import { noteContentHash } from '../src/clinical/note-hash.js';
import { allowedTeeth, type Dentition, normalizeOdontogram, odontogramHash } from '../src/clinical/odontogram/odontogram-spec.js';
import { igvOf } from '../src/integrations/billing-format.js';
import { DEMO_MARK as DOC_DEMO_MARK, POINTS_PER_CENTS } from '../src/integrations/integrations.constants.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createPrismaClient, type PrismaDb } from '../src/prisma/client.js';
import { assignmentKey } from '../src/users/assignment-key.js';
import { DEMO_PROOF_ID } from './demo-data.js';

/**
 * MÁS ODONTÓLOGOS, MÁS CITAS E HISTORIAS CLÍNICAS de demostración (todo FICTICIO). Solo desarrollo.
 *  - 4 odontólogos nuevos (Ortodoncia, Endodoncia, Odontopediatría, Cirugía e implantes) con horarios distintos, 2 consultorios
 *    nuevos (4 en total) y 5 servicios con precio.
 *  - ~120 citas: ~65 % en los 45 días anteriores (atendidas, canceladas y ausentes) y el resto hoy y en los próximos 21 días.
 *  - Por cada atención: visita cerrada, diagnóstico, procedimiento, evolución (a veces corregida) y, para los pacientes con
 *    varias atenciones, nuevas VERSIONES de odontograma escalonadas en el tiempo. Cobros con comprobantes simulados.
 *
 * Idempotente: si ya hay citas «Demo§:» de una ejecución completa no hace nada; los elementos base (usuarios, salas, servicios)
 * se buscan antes de crearse. El plan es determinista (PRNG con semilla fija y fechas absolutas en cada nota).
 * Rendimiento (túnel SSH): las historias se procesan por paciente en paralelo y citas, huecos, cobros, comprobantes, puntos y
 * cola se insertan por lotes.
 */
const TAG = 'Demo§:';
const REASON = 'DEMO§:';

interface Ctx { clinicId: string; branchId: string; adminUserId: string; receptionId: string; dentistId: string; password: string }
type ApptStatus = 'RESERVED' | 'CONFIRMED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';
type Money = 'CASH' | 'CARD' | 'YAPE_PLIN' | 'TRANSFER';

const DAY = 24 * 60;
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------ odontólogos, horarios, servicios
interface Win { weekdays: number[]; start: number; end: number }
const DENTISTS = [
  { email: 'odontologo2.demo@apidental.test', first: 'Alberto', last: 'Demo (ortodoncia)', specialty: 'Ortodoncia (demo)', room: 'Consultorio 3 (demo)', windows: [{ weekdays: [1, 2, 3, 4, 5], start: 8 * 60, end: 13 * 60 }] as Win[] },
  { email: 'odontologo3.demo@apidental.test', first: 'Carolina', last: 'Demo (endodoncia)', specialty: 'Endodoncia (demo)', room: 'Consultorio 4 (demo)', windows: [{ weekdays: [1, 2, 3, 4, 5], start: 13 * 60, end: 18 * 60 }] as Win[] },
  { email: 'odontologo4.demo@apidental.test', first: 'Fiorella', last: 'Demo (odontopediatría)', specialty: 'Odontopediatría (demo)', room: 'Consultorio 3 (demo)', windows: [{ weekdays: [2, 3, 4, 5, 6], start: 9 * 60, end: 15 * 60 }] as Win[] },
  { email: 'odontologo5.demo@apidental.test', first: 'Mauricio', last: 'Demo (cirugía e implantes)', specialty: 'Cirugía e implantes (demo)', room: 'Consultorio 4 (demo)', windows: [{ weekdays: [1, 3, 5], start: 14 * 60, end: 19 * 60 }, { weekdays: [6], start: 8 * 60, end: 13 * 60 }] as Win[] },
] as const;
const GENERAL_WINDOWS: Win[] = [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: 8 * 60, end: 18 * 60 }];

const NEW_SERVICES = [
  { name: 'Control de ortodoncia (demo)', minutes: 30, price: 12_000, specialty: 'Ortodoncia (demo)', code: 'DEMO-ORTODONCIA', consent: false },
  { name: 'Aplicación de flúor (demo)', minutes: 20, price: 4_500, specialty: 'Odontopediatría (demo)', code: 'DEMO-FLUOR', consent: false },
  { name: 'Pulpectomía infantil (demo)', minutes: 45, price: 22_000, specialty: 'Odontopediatría (demo)', code: 'DEMO-PULPECTOMIA', consent: true },
  { name: 'Cirugía de tercer molar (demo)', minutes: 60, price: 35_000, specialty: 'Cirugía e implantes (demo)', code: 'DEMO-CIRUGIA-MOLAR', consent: true },
  { name: 'Colocación de implante (demo)', minutes: 90, price: 180_000, specialty: 'Cirugía e implantes (demo)', code: 'DEMO-IMPLANTE', consent: true },
] as const;

/** Servicio → procedimiento, diagnósticos y relatos (variantes). Son declaraciones ficticias del profesional. */
const CLINICAL: Record<string, { code: string; dx: string[]; proc: string[]; evo: string[]; follow: (string | null)[] }> = {
  'Consulta (demo)': { code: 'DEMO-CONTROL', dx: ['Control general sin hallazgos nuevos', 'Gingivitis leve por placa', 'Sensibilidad dentinaria localizada'], proc: ['Examen clínico y revisión de higiene.', 'Revisión de la cavidad bucal con instrucciones de higiene.'], evo: ['Paciente colaborador; refiere molestias leves al frío.', 'Sin dolor al momento de la consulta; se explican hábitos de higiene.'], follow: ['Control en seis meses.', null] },
  'Control (demo)': { code: 'DEMO-CONTROL', dx: ['Control posterior a tratamiento, evolución favorable', 'Restauración en buen estado'], proc: ['Control de tratamiento previo.', 'Revisión de oclusión y bordes de restauraciones.'], evo: ['Evolución favorable; sin molestias.', 'Se revisa el tratamiento anterior sin hallazgos.'], follow: ['Control en tres meses.', null] },
  'Limpieza dental (demo)': { code: 'DEMO-LIMPIEZA', dx: ['Cálculo supragingival leve', 'Gingivitis asociada a placa'], proc: ['Profilaxis con ultrasonido y pulido.', 'Remoción de cálculo y pulido coronario.'], evo: ['Limpieza sin complicaciones; leve sangrado gingival.', 'Se instruye técnica de cepillado.'], follow: ['Limpieza en seis meses.', null] },
  'Restauración (demo)': { code: 'DEMO-RESTAURACION', dx: ['Caries oclusal en molar', 'Caries proximal en premolar'], proc: ['Restauración con resina compuesta.', 'Remoción de caries y restauración adhesiva.'], evo: ['Restauración realizada con aislamiento relativo; oclusión ajustada.', 'Procedimiento sin incidentes.'], follow: ['Revisar adaptación en un mes.', null] },
  'Endodoncia (demo)': { code: 'DEMO-ENDODONCIA', dx: ['Pulpitis irreversible sintomática', 'Necrosis pulpar con lesión periapical incipiente'], proc: ['Tratamiento de conductos en una sesión.', 'Instrumentación, irrigación y obturación de conductos.'], evo: ['Anestesia efectiva; conductos obturados; control radiográfico programado.', 'Paciente sin dolor al alta.'], follow: ['Restauración definitiva en dos semanas.', 'Control radiográfico a los seis meses.'] },
  'Control de ortodoncia (demo)': { code: 'DEMO-ORTODONCIA', dx: ['Ortodoncia fija en alineamiento', 'Apiñamiento anterior en corrección'], proc: ['Activación de arcos y revisión de brackets.', 'Cambio de ligaduras y ajuste de arco.'], evo: ['Progreso adecuado del alineamiento; higiene aceptable.', 'Se refuerza higiene alrededor de los brackets.'], follow: ['Próximo control en cuatro semanas.', 'Control mensual.'] },
  'Aplicación de flúor (demo)': { code: 'DEMO-FLUOR', dx: ['Riesgo cariogénico moderado', 'Prevención de caries en dentición mixta'], proc: ['Aplicación tópica de barniz de flúor.', 'Profilaxis y aplicación de flúor.'], evo: ['El niño colabora; se indica no comer por 30 minutos.', 'Aplicación sin incidentes.'], follow: ['Repetir en seis meses.', null] },
  'Pulpectomía infantil (demo)': { code: 'DEMO-PULPECTOMIA', dx: ['Pulpitis en molar temporal', 'Caries profunda en molar temporal'], proc: ['Pulpectomía y obturación en molar temporal.', 'Terapia pulpar en molar temporal con restauración provisional.'], evo: ['Procedimiento tolerado con manejo de conducta.', 'Se entregan indicaciones a la madre.'], follow: ['Corona de acero en dos semanas.', null] },
  'Sellante (demo)': { code: 'DEMO-SELLANTE', dx: ['Fosas y fisuras profundas, sin caries', 'Prevención en primeros molares permanentes'], proc: ['Sellado de fosas y fisuras.', 'Aplicación de sellantes en molares.'], evo: ['Aislamiento correcto; sellantes retenidos.', 'Sin molestias.'], follow: ['Revisar retención en seis meses.', null] },
  'Extracción (demo)': { code: 'DEMO-EXODONCIA', dx: ['Resto radicular no restaurable', 'Pieza con fractura vertical'], proc: ['Exodoncia simple.', 'Exodoncia con sutura y control de sangrado.'], evo: ['Hemostasia lograda; indicaciones postoperatorias entregadas.', 'Procedimiento sin complicaciones.'], follow: ['Control a los siete días.', null] },
  'Cirugía de tercer molar (demo)': { code: 'DEMO-CIRUGIA-MOLAR', dx: ['Tercer molar inferior incluido', 'Pericoronaritis recurrente'], proc: ['Exodoncia quirúrgica de tercer molar.', 'Odontosección y sutura.'], evo: ['Cirugía sin incidentes; edema esperado.', 'Se indica hielo local y dieta blanda.'], follow: ['Retiro de puntos a los siete días.', 'Control a las 48 horas.'] },
  'Colocación de implante (demo)': { code: 'DEMO-IMPLANTE', dx: ['Edentulismo parcial, rehabilitación con implante', 'Ausencia de molar inferior'], proc: ['Colocación de implante en zona edéntula.', 'Cirugía de implante con sutura.'], evo: ['Estabilidad primaria adecuada; sin complicaciones.', 'Se entregan indicaciones y control.'], follow: ['Control a las dos semanas; osteointegración en tres meses.', null] },
  'Corona (demo)': { code: 'DEMO-CORONA', dx: ['Pieza tratada que requiere cobertura'], proc: ['Preparación y cementado de corona.'], evo: ['Corona ajustada y cementada.'], follow: ['Revisar adaptación.'] },
  'Evaluación de implante (demo)': { code: 'DEMO-CONTROL', dx: ['Evaluación para rehabilitación con implantes'], proc: ['Evaluación clínica y radiográfica.'], evo: ['Se explican alternativas; el paciente decidirá.'], follow: ['Reevaluar en un mes.'] },
};

const CANCEL = ['Cancelada por el paciente (demostración)', 'Reprogramación solicitada por el paciente (demostración)', 'El paciente no pudo asistir por trabajo (demostración)'];
const NO_SHOW = ['No asistió ni avisó (demostración)', 'No contestó el recordatorio (demostración)'];
const METHODS: Money[] = ['CASH', 'CARD', 'YAPE_PLIN', 'TRANSFER'];

interface PatientRow { id: string; age: number; tag: string; inactive: boolean; birth: Date | null }
interface Plan { key: string; d: number; date: string; minute: number; service: string; patientId: string; status: ApptStatus; room: number; reason?: string }

const ageOf = (b: Date | null, today: string) => {
  if (!b) return 30;
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  let a = y - b.getUTCFullYear();
  if (m < b.getUTCMonth() + 1 || (m === b.getUTCMonth() + 1 && d < b.getUTCDate())) a--;
  return a;
};

export async function seedDemoClinicHistory(db: PrismaDb, c: Ctx): Promise<Record<string, number>> {
  const t0 = Date.now();
  const { clinicId, branchId, adminUserId, receptionId } = c;
  const stats = { dentists: 0, appointments: 0, visits: 0, odontogramVersions: 0, charges: 0, documents: 0, loyaltyEntries: 0, seconds: 0 };
  const rand = mulberry32(20261015);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
  const weighted = <T>(a: readonly (readonly [T, number])[]): T => {
    const total = a.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [v, w] of a) { r -= w; if (r <= 0) return v; }
    return a[a.length - 1]![0];
  };

  // ------------------------------------------------------------------ requisitos de los datos base
  const room12: string[] = [];
  for (const name of ['Consultorio 1 (demo)', 'Consultorio 2 (demo)']) {
    const r = await db.room.findUnique({ where: { branchId_name: { branchId, name } } });
    if (!r) return stats;
    room12.push(r.id);
  }
  const baseServices: Record<string, { id: string; minutes: number; price: number }> = {};
  for (const name of ['Consulta (demo)', 'Limpieza dental (demo)', 'Control (demo)', 'Restauración (demo)', 'Endodoncia (demo)', 'Extracción (demo)', 'Sellante (demo)', 'Corona (demo)', 'Evaluación de implante (demo)']) {
    const s = await db.agendaService.findUnique({ where: { clinicId_name: { clinicId, name } } });
    if (!s) return stats;
    baseServices[name] = { id: s.id, minutes: s.durationMinutes, price: s.priceCents ?? 10_000 };
  }

  // ------------------------------------------------------------------ odontólogos, especialidades, consultorios, servicios, definiciones y horarios
  const today = utcToLima(new Date()).date;
  const role = await db.role.findUniqueOrThrow({ where: { code: 'DENTIST' } });
  const passwordHash = await hashPassword(c.password);
  const dentistIds: string[] = [c.dentistId];
  const rooms: string[] = [...room12];
  for (const name of ['Consultorio 3 (demo)', 'Consultorio 4 (demo)']) {
    rooms.push((await db.room.findUnique({ where: { branchId_name: { branchId, name } } }))?.id ?? (await db.room.create({ data: { clinicId, branchId, name } })).id);
  }
  const specialties: Record<string, string> = {};
  for (const name of new Set(DENTISTS.map((d) => d.specialty))) {
    specialties[name] = (await db.specialty.findUnique({ where: { clinicId_name: { clinicId, name } } }))?.id ?? (await db.specialty.create({ data: { clinicId, name } })).id;
  }
  for (const [i, d] of DENTISTS.entries()) {
    let user = await db.user.findUnique({ where: { email: d.email } });
    if (!user) { user = await db.user.create({ data: { email: d.email, passwordHash, firstName: d.first, lastName: d.last } }); stats.dentists++; }
    dentistIds.push(user.id);
    const grant = { roleId: role.id, clinicId, branchId };
    await db.userAssignment.upsert({ where: { assignmentKey: assignmentKey(user.id, grant) }, update: { status: 'ACTIVE' }, create: { userId: user.id, ...grant, assignmentKey: assignmentKey(user.id, grant), grantedById: adminUserId } });
    await db.dentistSpecialty.upsert({ where: { userId_specialtyId: { userId: user.id, specialtyId: specialties[d.specialty]! } }, update: {}, create: { clinicId, userId: user.id, specialtyId: specialties[d.specialty]! } });
    if ((await db.scheduleRule.count({ where: { clinicId, dentistUserId: user.id, status: 'ACTIVE' } })) === 0) {
      const validFrom = new Date(`${addDays(today, -60)}T00:00:00.000Z`);
      await db.scheduleRule.createMany({
        data: d.windows.flatMap((w) => w.weekdays.map((weekday) => ({ clinicId, branchId, dentistUserId: user!.id, roomId: rooms[2 + (i % 2)]!, weekday, startMinute: w.start, endMinute: w.end, validFrom, createdById: adminUserId }))),
      });
    }
  }
  const services: Record<string, { id: string; minutes: number; price: number }> = { ...baseServices };
  const defs: Record<string, string> = {};
  for (const code of ['DEMO-CONTROL', 'DEMO-LIMPIEZA', 'DEMO-RESTAURACION', 'DEMO-ENDODONCIA', 'DEMO-EXODONCIA', 'DEMO-SELLANTE', 'DEMO-CORONA']) {
    const def = await db.procedureDefinition.findUnique({ where: { clinicId_code: { clinicId, code } } });
    if (!def) return stats;
    defs[code] = def.id;
  }
  for (const s of NEW_SERVICES) {
    const svc = (await db.agendaService.findUnique({ where: { clinicId_name: { clinicId, name: s.name } } })) ?? (await db.agendaService.create({ data: { clinicId, name: s.name, durationMinutes: s.minutes, priceCents: s.price, specialtyId: specialties[s.specialty]! } }));
    services[s.name] = { id: svc.id, minutes: svc.durationMinutes, price: svc.priceCents ?? s.price };
    defs[s.code] = ((await db.procedureDefinition.findUnique({ where: { clinicId_code: { clinicId, code: s.code } } })) ??
      (await db.procedureDefinition.create({ data: { clinicId, code: s.code, name: s.name.replace(' (demo)', ' (demo)'), description: 'Procedimiento de demostración (dato ficticio)', requiresClinicalConsent: s.consent, createdById: adminUserId } }))).id;
  }

  // ------------------------------------------------------------------ ya aplicado: no se repite
  const existing = await db.appointment.count({ where: { clinicId, notes: { startsWith: TAG } } });
  if (existing >= 60) { stats.seconds = (Date.now() - t0) / 1000; return stats; }

  // ------------------------------------------------------------------ pacientes demo y sus restricciones
  const patientsRaw = await db.patient.findMany({ where: { clinicId, lastName: 'Demo' }, select: { id: true, secondLastName: true, birthDate: true, status: true }, orderBy: { id: 'asc' } });
  const patients: PatientRow[] = patientsRaw.map((p) => ({ id: p.id, age: ageOf(p.birthDate, today), tag: (p.secondLastName ?? '').toLowerCase(), inactive: p.status !== 'ACTIVE', birth: p.birthDate }));
  if (patients.length < 10) return stats;
  const clinicalOk = new Set((await db.patientConsent.findMany({ where: { clinicId, type: 'CLINICAL', status: 'GRANTED' }, select: { patientId: true } })).map((x) => x.patientId));
  const openVisit = new Set((await db.clinicalVisit.findMany({ where: { clinicId, status: 'OPEN' }, select: { patientId: true, dentistUserId: true } })).map((v) => `${v.patientId}|${v.dentistUserId}`));
  const lovedBy: Record<string, number[]> = { // etiquetas del caso → odontólogos más coherentes (0 = general)
    ortodoncia: [1], caries: [3, 0], mixta: [3, 1], pequeño: [3], joven: [1, 0], hipertenso: [2, 4], endodoncia: [2], bruxismo: [2, 0], alergia: [2, 0],
    implantes: [4], 'prótesis': [4], extranjero: [4, 0], gestante: [0], nueva: [1, 0], reciente: [1, 0],
  };
  const poolFor = (d: number, forAttended: boolean) => {
    const list: PatientRow[] = [];
    for (const p of patients) {
      if (forAttended && !clinicalOk.has(p.id)) continue;
      const loved = lovedBy[p.tag]?.includes(d) ?? false;
      const ok = d === 0 ? p.age >= 6 : d === 1 ? p.age >= 6 && p.age <= 35 : d === 2 ? p.age >= 14 : d === 3 ? p.age < 13 : p.age >= 16;
      if (!ok && !loved) continue;
      if (d === 3 && p.age >= 13) continue;
      if (forAttended && openVisit.has(`${p.id}|${dentistIds[d]}`)) continue;
      for (let k = 0; k < (loved ? 4 : 1); k++) list.push(p);
    }
    return list.length ? list : patients.filter((p) => (!forAttended || clinicalOk.has(p.id)) && (d === 3 ? p.age < 13 : p.age >= 14));
  };
  const serviceMix: Record<number, readonly (readonly [string, number])[]> = {
    0: [['Consulta (demo)', 3], ['Control (demo)', 3], ['Limpieza dental (demo)', 2], ['Restauración (demo)', 2]],
    1: [['Control de ortodoncia (demo)', 7], ['Consulta (demo)', 1]],
    2: [['Endodoncia (demo)', 4], ['Control (demo)', 2], ['Restauración (demo)', 1]],
    3: [['Aplicación de flúor (demo)', 3], ['Pulpectomía infantil (demo)', 2], ['Sellante (demo)', 2], ['Control (demo)', 1]],
    4: [['Cirugía de tercer molar (demo)', 3], ['Colocación de implante (demo)', 2], ['Extracción (demo)', 3], ['Evaluación de implante (demo)', 2]],
  };
  const windowsOf = (d: number): Win[] => (d === 0 ? GENERAL_WINDOWS : (DENTISTS[d - 1]!.windows as unknown as Win[]));

  // ------------------------------------------------------------------ ocupación existente (de otras semillas), para no chocar
  const rangeFrom = limaToUtc(addDays(today, -46), 0);
  const rangeTo = limaToUtc(addDays(today, 23), 0);
  const busy = new Map<string, [number, number][]>();
  const mark = (k: string, s: number, e: number) => { (busy.get(k) ?? busy.set(k, []).get(k)!).push([s, e]); };
  const isFree = (k: string, s: number, e: number) => !(busy.get(k) ?? []).some(([bs, be]) => s < be && e > bs);
  for (const a of await db.appointment.findMany({ where: { clinicId, status: { in: ['RESERVED', 'CONFIRMED', 'ATTENDED'] }, startsAt: { gte: rangeFrom, lt: rangeTo }, NOT: { notes: { startsWith: TAG } } }, select: { dentistUserId: true, roomId: true, startsAt: true, endsAt: true } })) {
    mark(`D|${a.dentistUserId}`, a.startsAt.getTime(), a.endsAt.getTime());
    mark(`R|${a.roomId}`, a.startsAt.getTime(), a.endsAt.getTime());
  }
  // Huecos ya ocupados por cualquier dueño (el odontólogo base es global por correo: puede tener citas de otra clínica).
  for (const s of await db.appointmentSlot.findMany({ where: { resourceId: { in: [...dentistIds, ...rooms] }, slotStart: { gte: rangeFrom, lt: rangeTo } }, select: { resourceKind: true, resourceId: true, slotStart: true } })) {
    mark(`${s.resourceKind === 'DENTIST' ? 'D' : 'R'}|${s.resourceId}`, s.slotStart.getTime(), s.slotStart.getTime() + 300_000);
  }

  // ------------------------------------------------------------------ plan determinista de citas
  const plan: Plan[] = [];
  const nowMinute = utcToLima(new Date()).minute;
  const place = (d: number, date: string, minLo: number, minHi: number, status: ApptStatus, forAttended: boolean): boolean => {
    const wins = windowsOf(d).filter((w) => w.weekdays.includes(weekdayOfDate(date)));
    if (wins.length === 0) return false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const w = pick(wins);
      const service = weighted(serviceMix[d]!);
      const minutes = services[service]!.minutes;
      const lo = Math.max(w.start, minLo);
      const hi = Math.min(w.end - minutes, minHi);
      if (hi < lo) continue;
      const slots = Math.floor((hi - lo) / 15) + 1;
      const minute = lo + Math.floor(rand() * slots) * 15;
      const start = limaToUtc(date, minute).getTime();
      const end = start + minutes * 60_000;
      if (!isFree(`D|${dentistIds[d]}`, start, end)) continue;
      const room = [0, 1, 2, 3].find((r) => isFree(`R|${rooms[r]}`, start, end));
      if (room === undefined) continue;
      const pool = poolFor(d, forAttended);
      const patient = pick(pool);
      if (patient.inactive && date >= today) continue; // el inactivo solo tiene historia pasada
      mark(`D|${dentistIds[d]}`, start, end);
      mark(`R|${rooms[room]}`, start, end);
      plan.push({
        key: `${date}|${d}|${hhmm(minute)}`, d, date, minute, service, patientId: patient.id, status, room,
        ...(status === 'CANCELLED' ? { reason: pick(CANCEL) } : status === 'NO_SHOW' ? { reason: pick(NO_SHOW) } : {}),
      });
      return true;
    }
    return false;
  };
  const quotas = [{ past: 10, future: 4 }, { past: 16, future: 7 }, { past: 16, future: 7 }, { past: 17, future: 7 }, { past: 17, future: 7 }];
  for (let d = 0; d < 5; d++) {
    for (let k = 0, made = 0, guard = 0; made < quotas[d]!.past && guard < 400; guard++) {
      const date = addDays(today, -(1 + Math.floor(rand() * 45)));
      const status = weighted<ApptStatus>([['ATTENDED', 80], ['CANCELLED', 10], ['NO_SHOW', 10]]);
      if (place(d, date, 0, DAY, status, status === 'ATTENDED')) { made++; k++; }
    }
    for (let made = 0, guard = 0; made < quotas[d]!.future && guard < 400; guard++) {
      const date = addDays(today, 1 + Math.floor(rand() * 21));
      if (place(d, date, 0, DAY, weighted<ApptStatus>([['CONFIRMED', 45], ['RESERVED', 55]]), false)) made++;
    }
    // Hoy: una atendida temprano (si ya pasó) y dos más adelante, en horas distintas.
    if (nowMinute > 9 * 60 + 30) place(d, today, 0, nowMinute - 90, 'ATTENDED', true);
    const later = Math.ceil((nowMinute + 45) / 15) * 15;
    for (let n = 0; n < 2; n++) place(d, today, later, DAY, weighted<ApptStatus>([['CONFIRMED', 50], ['RESERVED', 50]]), false);
  }
  plan.sort((a, b) => a.key.localeCompare(b.key));

  // ------------------------------------------------------------------ relaciones asistenciales necesarias
  const pairs = new Map<string, { patientId: string; dentistUserId: string }>();
  for (const p of plan) pairs.set(`${p.patientId}|${dentistIds[p.d]}`, { patientId: p.patientId, dentistUserId: dentistIds[p.d]! });
  await db.patientCareRelationship.createMany({
    data: [...pairs.values()].map((r) => ({ clinicId, patientId: r.patientId, dentistUserId: r.dentistUserId, source: 'ASSIGNMENT' as const, activeKey: `${r.patientId}|${r.dentistUserId}|*`, reason: 'Asignación de demostración', createdById: receptionId })),
    skipDuplicates: true,
  });
  const relRows = await db.patientCareRelationship.findMany({ where: { clinicId, activeKey: { in: [...pairs.keys()].map((k) => `${k}|*`) } }, select: { id: true, patientId: true, dentistUserId: true } });
  const relOf = new Map(relRows.map((r) => [`${r.patientId}|${r.dentistUserId}`, r.id]));

  // ------------------------------------------------------------------ historias por paciente (en paralelo entre pacientes)
  const pool = createPrismaClient(process.env['DATABASE_URL']!, 8);
  const maxVisit = new Map((await db.clinicalVisit.groupBy({ by: ['patientId'], where: { clinicId }, _max: { visitNumber: true } })).map((v) => [v.patientId, v._max.visitNumber ?? 0]));
  const visitOf = new Map<string, string>(); // plan.key → visitId
  const byPatient = new Map<string, Plan[]>();
  for (const p of plan) (byPatient.get(p.patientId) ?? byPatient.set(p.patientId, []).get(p.patientId)!).push(p);
  const patientInfo = new Map(patients.map((p) => [p.id, p]));

  const background = async (patientId: string, kind: 'BACKGROUND' | 'ALLERGY', label: string, condition: string, category: string, alert?: { severity: 'INFO' | 'WARNING' | 'CRITICAL'; text: string }) => {
    if (await db.clinicalHistoryEntry.findFirst({ where: { patientId, kind, label } })) return;
    const itemId = randomUUID();
    await db.clinicalHistoryEntry.create({ data: { clinicId, patientId, itemId, version: 1, currentKey: itemId, kind, label, condition, category, severity: 'MILD', isCritical: false, source: 'PATIENT', observations: 'Dato ficticio para la demostración.', changeKind: 'CREATED', createdById: c.dentistId } });
    if (kind === 'ALLERGY' && !(await db.clinicalAllergyAssessment.findFirst({ where: { patientId } })))
      await db.clinicalAllergyAssessment.create({ data: { clinicId, patientId, version: 1, currentKey: patientId, status: 'ALLERGIES_RECORDED', assessedOn: new Date(), source: 'PROFESSIONAL', changeKind: 'CREATED', automatic: true, createdById: c.dentistId } });
    if (alert) { const id = randomUUID(); await db.clinicalAlert.create({ data: { clinicId, patientId, itemId: id, version: 1, currentKey: id, severity: alert.severity, text: alert.text, source: 'PROFESSIONAL', changeKind: 'CREATED', createdById: c.dentistId } }); }
  };

  const doVisit = async (cl: PrismaDb, item: Plan, patientId: string, number: number) => {
    const dentistId = dentistIds[item.d]!;
    const spec = CLINICAL[item.service]!;
    const start = limaToUtc(item.date, item.minute);
    const minutes = services[item.service]!.minutes;
    const relId = relOf.get(`${patientId}|${dentistId}`)!;
    const visit = await cl.clinicalVisit.create({
      data: { clinicId, patientId, branchId, dentistUserId: dentistId, careRelationshipId: relId, visitNumber: number, openKey: `${patientId}|${dentistId}`, reason: `${REASON} ${item.service} · ${item.key}`, startedAt: start, createdById: dentistId },
    });
    const dxId = randomUUID();
    await cl.clinicalDiagnosis.create({ data: { clinicId, patientId, visitId: visit.id, itemId: dxId, version: 1, currentKey: dxId, description: pick(spec.dx), certainty: rand() < 0.7 ? 'DEFINITIVE' : 'PRESUMPTIVE', changeKind: 'CREATED', createdById: dentistId } });
    const def = await cl.procedureDefinition.findUniqueOrThrow({ where: { id: defs[spec.code]! }, select: { id: true, code: true, name: true, requiresClinicalConsent: true } });
    const pid = randomUUID();
    const procNotes = pick(spec.proc);
    const v1 = await cl.clinicalProcedure.create({ data: { clinicId, patientId, visitId: visit.id, itemId: pid, version: 1, currentKey: pid, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes: procNotes, performedAt: start, changeKind: 'CREATED', createdById: dentistId } });
    await cl.clinicalProcedure.update({ where: { id: v1.id }, data: { currentKey: null } });
    await cl.clinicalProcedure.create({ data: { clinicId, patientId, visitId: visit.id, itemId: pid, version: 2, supersedesId: v1.id, currentKey: pid, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes: procNotes, performedAt: start, status: 'CLOSED', closedAt: addMinutes(start, minutes), closureConsent: def.requiresClinicalConsent ? 'GRANTED' : 'NOT_REQUIRED', changeKind: 'CLOSED', createdById: dentistId } });
    // Evolución: borrador → cerrada (→ corregida en ~15 %)
    const nid = randomUUID();
    const body = `${pick(spec.evo)} (dato ficticio)`;
    const follow = pick(spec.follow);
    const n1 = await cl.clinicalNote.create({ data: { clinicId, patientId, visitId: visit.id, itemId: nid, version: 1, currentKey: nid, visitKey: visit.id, status: 'DRAFT', body, followUp: follow, changeKind: 'CREATED', createdById: dentistId } });
    await cl.clinicalNote.update({ where: { id: n1.id }, data: { currentKey: null, visitKey: null } });
    const closedAt = addMinutes(start, minutes + 10);
    const n2 = await cl.clinicalNote.create({ data: { clinicId, patientId, visitId: visit.id, itemId: nid, version: 2, supersedesId: n1.id, currentKey: nid, visitKey: visit.id, status: 'CLOSED', body, followUp: follow, changeKind: 'CLOSED', contentHash: noteContentHash({ itemId: nid, version: 2, visitId: visit.id, patientId, body, followUp: follow }), closedAt, reauthProofId: DEMO_PROOF_ID, createdById: dentistId } });
    if (rand() < 0.15) {
      await cl.clinicalNote.update({ where: { id: n2.id }, data: { currentKey: null, visitKey: null } });
      const fixed = `${body} Aclaración posterior de demostración.`;
      await cl.clinicalNote.create({ data: { clinicId, patientId, visitId: visit.id, itemId: nid, version: 3, supersedesId: n2.id, currentKey: nid, visitKey: visit.id, status: 'CLOSED', body: fixed, followUp: follow, changeKind: 'CORRECTED', changeReason: 'Se agrega una aclaración de ejemplo', contentHash: noteContentHash({ itemId: nid, version: 3, visitId: visit.id, patientId, body: fixed, followUp: follow }), closedAt: addMinutes(closedAt, 60), reauthProofId: DEMO_PROOF_ID, createdById: dentistId } });
    }
    await cl.clinicalVisit.update({ where: { id: visit.id }, data: { status: 'CLOSED', openKey: null, closedAt, version: { increment: 1 } } });
    visitOf.set(item.key, visit.id);
    stats.visits++;
  };

  /** Odontograma: continúa la cadena existente (si está cerrada) o crea la primera, con hallazgos que evolucionan. */
  const evolveOdontograms = async (cl: PrismaDb, patientId: string, attendedItems: Plan[]) => {
    if (attendedItems.length < 2) return;
    const info = patientInfo.get(patientId)!;
    const head = await cl.clinicalOdontogram.findFirst({ where: { patientId, currentKey: { not: null } } });
    if (head && head.status !== 'CLOSED') return; // borrador en curso: no se toca
    const dentition: Dentition = head ? (head.dentition as Dentition) : info.age < 6 ? 'PRIMARY' : info.age < 13 ? 'MIXED' : 'PERMANENT';
    const allowed = allowedTeeth(dentition);
    const posterior = allowed.filter((t) => ['4', '5', '6', '7', '8'].includes(t[1]!) && (t[0]! <= '4' ? Number(t[1]) >= 4 : Number(t[1]) >= 4));
    let teeth: Record<string, { status?: string; surfaces?: Record<string, { state: string }>; marks?: string[] }> = head ? JSON.parse(JSON.stringify((head.data as { teeth?: object }).teeth ?? {})) : {};
    const steps = Math.min(3, Math.max(1, attendedItems.length - 1));
    const at = attendedItems.length <= steps ? attendedItems : [attendedItems[0]!, attendedItems[Math.floor(attendedItems.length / 2)]!, attendedItems[attendedItems.length - 1]!].slice(0, steps);
    let prev: { id: string; version: number } | null = head ? { id: head.id, version: head.version } : null;
    for (const [i, item] of at.entries()) {
      // Cambios de esta versión
      const free = posterior.filter((t) => !teeth[t]?.status);
      const cariesTeeth = Object.entries(teeth).filter(([, v]) => Object.values(v.surfaces ?? {}).some((s) => s.state === 'CARIES')).map(([k]) => k);
      for (const t of cariesTeeth.slice(0, 2)) for (const s of Object.keys(teeth[t]!.surfaces ?? {})) if (teeth[t]!.surfaces![s]!.state === 'CARIES') teeth[t]!.surfaces![s] = { state: 'RESTORATION' };
      const n = prev ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 2);
      for (let k = 0; k < n && free.length; k++) {
        const tooth = free.splice(Math.floor(rand() * free.length), 1)[0]!;
        const surface = pick(['O', 'M', 'D', 'V', 'L']);
        const state = info.age < 13 && rand() < 0.4 ? 'SEALANT' : rand() < 0.75 ? 'CARIES' : 'RESTORATION';
        teeth[tooth] = { ...(teeth[tooth] ?? {}), surfaces: { ...(teeth[tooth]?.surfaces ?? {}), [surface]: { state } } };
      }
      if (info.age >= 35 && i === steps - 1 && free.length && rand() < 0.5) { const t = pick(free); teeth[t] = { ...(teeth[t] ?? {}), marks: ['CROWN'] }; }
      const data = normalizeOdontogram({ schema: 'apidental.odontogram', schemaVersion: 1, teeth, notes: `Revisión de demostración del ${item.date} (dato ficticio).` }, dentition);
      const at0 = addMinutes(limaToUtc(item.date, item.minute), services[item.service]!.minutes + 5);
      const dentistId = dentistIds[item.d]!;
      const base = { clinicId, patientId, dentition, data: data as never, changeKind: 'UPDATED' as const, changeReason: null, createdById: dentistId };
      if (prev) await cl.clinicalOdontogram.update({ where: { id: prev.id }, data: { currentKey: null } });
      const draft: { id: string; version: number } = await cl.clinicalOdontogram.create({ data: { ...base, changeKind: prev ? 'UPDATED' : 'CREATED', version: (prev?.version ?? 0) + 1, supersedesId: prev?.id ?? null, currentKey: patientId, status: 'DRAFT', createdAt: addMinutes(at0, -20) } });
      await cl.clinicalOdontogram.update({ where: { id: draft.id }, data: { currentKey: null } });
      const version = draft.version + 1;
      prev = await cl.clinicalOdontogram.create({ data: { ...base, changeKind: prev ? 'UPDATED' : 'CREATED', version, supersedesId: draft.id, currentKey: patientId, status: 'CLOSED', contentHash: odontogramHash({ patientId, version, dentition, data }), closedAt: at0, createdAt: at0 } });
      stats.odontogramVersions++;
    }
  };

  const groups = [...byPatient.entries()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < groups.length) {
      const [patientId, items] = groups[cursor++]!;
      const attended = items.filter((i) => i.status === 'ATTENDED').sort((a, b) => a.key.localeCompare(b.key));
      let number = maxVisit.get(patientId) ?? 0;
      for (const item of attended) {
        if (await pool.clinicalVisit.findFirst({ where: { patientId, reason: `${REASON} ${item.service} · ${item.key}` }, select: { id: true } }).then((v) => { if (v) visitOf.set(item.key, v.id); return Boolean(v); })) continue;
        await doVisit(pool, item, patientId, ++number);
      }
      await evolveOdontograms(pool, patientId, attended);
    }
  };
  try {
    await Promise.all(Array.from({ length: 8 }, () => worker()));
  } finally {
    await pool.$disconnect();
  }

  // Antecedentes para pacientes con poca historia
  const bgPlan: [string, string, 'BACKGROUND' | 'ALLERGY', string, string, string][] = [
    ['joven', 'Asma leve (demo)', 'BACKGROUND', 'Controlada con inhalador (dato ficticio)', 'Condición', ''],
    ['nueva', 'Alergia al látex (demo)', 'ALLERGY', 'Irritación cutánea de ejemplo (ficticia)', 'Material', 'Usar guantes sin látex (dato ficticio)'],
    ['mayor', 'Hipotiroidismo (demo)', 'BACKGROUND', 'En tratamiento (dato ficticio)', 'Condición', ''],
  ];
  for (const [tag, label, kind, cond, cat, alertText] of bgPlan) {
    const p = patients.find((x) => x.tag === tag);
    if (p) await background(p.id, kind, label, cond, cat, alertText ? { severity: 'WARNING', text: alertText } : undefined);
  }

  // ------------------------------------------------------------------ citas, huecos, cobros, comprobantes, puntos y cola (por lotes)
  const apptIds = new Map<string, string>();
  const rows = plan.map((p) => {
    const id = randomUUID();
    apptIds.set(p.key, id);
    const svc = services[p.service]!;
    const start = limaToUtc(p.date, p.minute);
    const visitId = visitOf.get(p.key);
    return { p, id, start, end: addMinutes(start, svc.minutes), visitId };
  }).filter((r) => r.p.status !== 'ATTENDED' || r.visitId);
  const already = new Set((await db.appointment.findMany({ where: { clinicId, notes: { startsWith: TAG } }, select: { notes: true } })).map((a) => a.notes));
  const fresh = rows.filter((r) => !already.has(`${TAG}${r.p.key}|${r.p.service}`));
  for (let i = 0; i < fresh.length; i += 40) {
    const batch = fresh.slice(i, i + 40);
    await db.$transaction(async (tx) => {
      await tx.appointment.createMany({
        data: batch.map((r) => ({
          id: r.id, clinicId, branchId, patientId: r.p.patientId, dentistUserId: dentistIds[r.p.d]!, roomId: rooms[r.p.room]!, serviceId: services[r.p.service]!.id, startsAt: r.start, endsAt: r.end,
          status: r.p.status, notes: `${TAG}${r.p.key}|${r.p.service}`, createdById: receptionId,
          ...(r.p.status === 'CONFIRMED' ? { confirmedById: receptionId, confirmedAt: new Date() } : {}),
          ...(r.p.status === 'ATTENDED' ? { visitId: r.visitId!, attendedAt: r.start } : {}),
          ...(r.p.status === 'CANCELLED' ? { cancelReason: r.p.reason! } : {}),
          ...(r.p.status === 'NO_SHOW' ? { noShowReason: r.p.reason! } : {}),
        })),
      });
      const slotRows = batch.filter((r) => r.p.status === 'RESERVED' || r.p.status === 'CONFIRMED').flatMap((r) => {
        const starts = slotStarts(r.start, r.end);
        return [
          ...starts.map((slotStart) => ({ resourceKind: 'DENTIST' as const, resourceId: dentistIds[r.p.d]!, slotStart, ownerKind: 'APPOINTMENT' as const, ownerId: r.id, clinicId })),
          ...starts.map((slotStart) => ({ resourceKind: 'ROOM' as const, resourceId: rooms[r.p.room]!, slotStart, ownerKind: 'APPOINTMENT' as const, ownerId: r.id, clinicId })),
        ];
      });
      if (slotRows.length) await tx.appointmentSlot.createMany({ data: slotRows });
    });
  }
  stats.appointments = fresh.length;

  // Cobros: ~40 % de las atendidas pagadas (con comprobante), las 6 más recientes sin pagar.
  const attendedRows = fresh.filter((r) => r.p.status === 'ATTENDED').sort((a, b) => a.p.key.localeCompare(b.p.key));
  const consentRows = await db.patientConsent.findMany({ where: { clinicId, type: { in: ['LOYALTY', 'MARKETING'] } }, select: { patientId: true, type: true } });
  const loyalty = new Set(consentRows.filter((x) => x.type === 'LOYALTY').map((x) => x.patientId));
  const marketing = new Set(consentRows.filter((x) => x.type === 'MARKETING').map((x) => x.patientId));
  const names = new Map((await db.patient.findMany({ where: { clinicId, id: { in: [...new Set(attendedRows.map((r) => r.p.patientId))] } }, select: { id: true, firstName: true, lastName: true, secondLastName: true } })).map((p) => [p.id, [p.firstName, p.lastName, p.secondLastName].filter(Boolean).join(' ')]));
  const idents = new Map((await db.patientIdentifier.findMany({ where: { clinicId, status: 'ACTIVE', patientId: { in: [...names.keys()] } }, select: { patientId: true, type: true, number: true } })).map((i) => [i.patientId, i]));
  const counters = new Map((await db.billingCounter.findMany({ where: { clinicId, series: { in: ['BD01', 'FD01'] } } })).map((c) => [c.series, Number(c.last)]));
  const next = (series: string) => { const n = (counters.get(series) ?? 0) + 1; counters.set(series, n); return n; };

  const charges: Prisma.ChargeCreateManyInput[] = [];
  const docs: Prisma.BillingDocumentCreateManyInput[] = [];
  const provider: Prisma.MockProviderRecordCreateManyInput[] = [];
  const outbox: Prisma.IntegrationOutboxCreateManyInput[] = [];
  const accruals: Prisma.MockLoyaltyEntryCreateManyInput[] = [];
  const reviews: Prisma.MockReviewRequestCreateManyInput[] = [];
  const recent = new Set(attendedRows.slice(-6).map((r) => r.id));
  const known = new Set((await db.charge.findMany({ where: { clinicId, appointmentId: { in: attendedRows.map((r) => r.id) } }, select: { appointmentId: true } })).map((c) => c.appointmentId));
  for (const r of attendedRows) {
    if (known.has(r.id)) continue;
    const paid = !recent.has(r.id) && rand() < 0.45;
    if (!paid && !recent.has(r.id)) continue;
    const svc = services[r.p.service]!;
    const chargeId = randomUUID();
    const createdAt = r.start;
    const paidAt = addMinutes(createdAt, 20);
    charges.push({
      id: chargeId, clinicId, branchId, patientId: r.p.patientId, appointmentId: r.id, appointmentKey: r.id, description: r.p.service, amountCents: svc.price, createdById: receptionId, createdAt,
      ...(paid ? { status: 'PAID' as const, paymentMethod: pick(METHODS), paidAt, paidById: receptionId, version: 2 } : {}),
    });
    if (!paid) continue;
    const at = paidAt;
    const points = Math.floor(svc.price / POINTS_PER_CENTS);
    const lk = `loyalty-accrue:${chargeId}`;
    if (loyalty.has(r.p.patientId)) {
      accruals.push({ clinicId, patientRef: r.p.patientId, kind: 'ACCRUAL', points, reason: 'Pago de atención (simulado)', idempotencyKey: lk, createdAt: at });
      outbox.push({ clinicId, kind: 'LOYALTY_ACCRUE', aggregateType: 'Charge', aggregateId: chargeId, idempotencyKey: lk, status: 'DONE', attempts: 1, note: `+${points} puntos (simulado)`, createdAt: at, processedAt: at, nextAttemptAt: at });
    } else outbox.push({ clinicId, kind: 'LOYALTY_ACCRUE', aggregateType: 'Charge', aggregateId: chargeId, idempotencyKey: lk, status: 'SKIPPED', attempts: 1, note: 'Sin autorización de fidelización del paciente', createdAt: at, processedAt: at, nextAttemptAt: at });
    const rk = `review:${chargeId}`;
    if (marketing.has(r.p.patientId)) {
      reviews.push({ clinicId, patientRef: r.p.patientId, idempotencyKey: rk, createdAt: at });
      outbox.push({ clinicId, kind: 'REVIEW_REQUEST', aggregateType: 'Charge', aggregateId: chargeId, idempotencyKey: rk, status: 'DONE', attempts: 1, note: 'Solicitud enviada (simulada)', createdAt: at, processedAt: at, nextAttemptAt: at });
    } else outbox.push({ clinicId, kind: 'REVIEW_REQUEST', aggregateType: 'Charge', aggregateId: chargeId, idempotencyKey: rk, status: 'SKIPPED', attempts: 1, note: 'Sin autorización de comunicaciones (marketing) del paciente', createdAt: at, processedAt: at, nextAttemptAt: at });
    // Comprobante simulado (marca DEMO) con estados variados
    const kind = weighted<'ISSUED' | 'SENT' | 'RETRYABLE_ERROR' | 'NEEDS_RECONCILIATION'>([['ISSUED', 88], ['SENT', 4], ['RETRYABLE_ERROR', 4], ['NEEDS_RECONCILIATION', 4]]);
    const scenario = { ISSUED: 'ISSUE', SENT: 'PENDING', RETRYABLE_ERROR: 'ERROR_THEN_OK', NEEDS_RECONCILIATION: 'TIMEOUT' }[kind] as 'ISSUE' | 'PENDING' | 'ERROR_THEN_OK' | 'TIMEOUT';
    const idem = `doc:${chargeId}:1`;
    const ref = `DEMO-${idem.replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase()}`;
    const ident = idents.get(r.p.patientId);
    const docAt = addMinutes(createdAt, 31);
    docs.push({
      clinicId, chargeId, type: 'BOLETA', series: 'BD01', number: next('BD01'), status: kind, customerName: names.get(r.p.patientId) ?? 'Paciente Demo', customerDocType: ident?.type ?? 'DNI', customerDocNumber: ident?.number ?? '-',
      amountCents: svc.price, igvCents: igvOf(svc.price), demoMark: DOC_DEMO_MARK, idempotencyKey: idem, activeKey: chargeId, scenario, attempts: 1, lastAttemptAt: docAt, createdById: receptionId, createdAt,
      ...(kind === 'ISSUED' || kind === 'NEEDS_RECONCILIATION' ? { issuedAt: docAt } : {}), ...(kind !== 'RETRYABLE_ERROR' ? { providerRef: ref } : {}),
    });
    const state = { ISSUED: 'ISSUED', SENT: 'PENDING', RETRYABLE_ERROR: 'TRANSIENT', NEEDS_RECONCILIATION: 'ISSUED' }[kind];
    provider.push({ idempotencyKey: idem, kind: 'BILLING', state, attempts: 1, ...(kind === 'RETRYABLE_ERROR' ? {} : { result: { providerRef: ref, issuedAt: docAt.toISOString() } as never }) });
    outbox.push({ clinicId, kind: 'BILLING_EMIT', aggregateType: 'BillingDocument', aggregateId: chargeId, idempotencyKey: `emit:${idem}`, status: kind === 'RETRYABLE_ERROR' ? 'PENDING' : 'DONE', attempts: 1, note: { ISSUED: 'Emitido (simulado)', SENT: 'Enviado; falta la confirmación (concilie)', RETRYABLE_ERROR: 'Servicio no disponible (simulado); se reintentará', NEEDS_RECONCILIATION: 'Sin respuesta a tiempo; requiere conciliación' }[kind], createdAt: docAt, processedAt: kind === 'RETRYABLE_ERROR' ? null : docAt, nextAttemptAt: kind === 'RETRYABLE_ERROR' ? new Date(Date.now() + 3_600_000) : docAt });
  }
  if (charges.length) {
    await db.charge.createMany({ data: charges });
    if (docs.length) {
      // Los comprobantes referencian el cobro: se asignó aggregateId = chargeId en la cola (mismo id que el documento no existe aún).
      await db.billingDocument.createMany({ data: docs });
      await db.$executeRaw`INSERT IGNORE INTO billing_counters (clinic_id, series, last) VALUES (${clinicId}, 'BD01', 0)`;
      await db.$executeRaw`UPDATE billing_counters SET last = ${counters.get('BD01') ?? 0} WHERE clinic_id = ${clinicId} AND series = 'BD01'`;
      await db.mockProviderRecord.createMany({ data: provider, skipDuplicates: true });
    }
    if (accruals.length) await db.mockLoyaltyEntry.createMany({ data: accruals, skipDuplicates: true });
    if (reviews.length) await db.mockReviewRequest.createMany({ data: reviews, skipDuplicates: true });
    // La cola de comprobantes apunta al documento: se corrige el aggregateId con el id real.
    const created = await db.billingDocument.findMany({ where: { clinicId, chargeId: { in: charges.map((x) => x.id as string) } }, select: { id: true, chargeId: true } });
    const docOfCharge = new Map(created.map((d) => [d.chargeId, d.id]));
    for (const o of outbox) if (o.kind === 'BILLING_EMIT') o.aggregateId = docOfCharge.get(o.aggregateId) ?? o.aggregateId;
    await db.integrationOutbox.createMany({ data: outbox, skipDuplicates: true });
  }
  stats.charges = charges.length;
  stats.documents = docs.length;
  stats.loyaltyEntries = accruals.length;
  stats.seconds = Math.round((Date.now() - t0) / 100) / 10;
  return stats;
}
