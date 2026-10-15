import { createHash } from 'node:crypto';
import { addDays, addMinutes, limaToUtc, slotStarts, utcToLima } from '../src/agenda/agenda-time.js';
import { noteContentHash } from '../src/clinical/note-hash.js';
import { type Dentition, normalizeOdontogram, odontogramHash } from '../src/clinical/odontogram/odontogram-spec.js';
import { DEMO_MARK as DOC_DEMO_MARK, POINTS_PER_CENTS } from '../src/integrations/integrations.constants.js';
import { igvOf } from '../src/integrations/billing-format.js';
import { contactRow, identifierRow, prepareContacts, prepareIdentifier } from '../src/patients/patient-data.js';
import { toDateOnly } from '../src/patients/util/lima-date.js';
import type { PrismaDb } from '../src/prisma/client.js';
import { DEMO_PROOF_ID } from './demo-data.js';

/**
 * DIEZ CASOS DE PACIENTE de demostración (todo FICTICIO: apellido «Demo» + una característica, documentos 9000002x,
 * CE y pasaporte inventados, celulares 9000000xx, correos @example.test / @apidental.test, textos marcados como demostración).
 * Cada uno muestra una situación distinta del flujo: gestante con alergia, adulto con antecedentes críticos, niño con
 * caries (dentición mixta), adolescente en ortodoncia, adulto mayor con prótesis e implantes, extranjero con CE,
 * pasaporte sin celular y sin consentimiento clínico, paciente inactivo, bruxismo con varias visitas y una paciente nueva
 * con solicitudes de cita web (pendiente y rechazada).
 *
 * Solo desarrollo. Idempotente: cada elemento se busca antes de crearlo (por documento, motivo de visita, nota de cita,
 * descripción de cobro, clave de idempotencia o referencia). Las citas futuras se colocan en horario de trabajo de Lima
 * (08:00–18:00, múltiplos de 15 min) en el primer hueco libre del odontólogo, sin chocar con las citas existentes.
 */
const NOTE = 'Demo#:';
const REASON = 'DEMO#:';

interface Ctx { clinicId: string; branchId: string; dentistId: string; receptionId: string; adminUserId: string }
type Money = 'CASH' | 'CARD' | 'YAPE_PLIN' | 'TRANSFER';
type Scenario = 'ISSUE' | 'PENDING' | 'REJECT' | 'ERROR_THEN_OK' | 'TIMEOUT';
type ApptStatus = 'RESERVED' | 'CONFIRMED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';

const hours = (n: number) => n * 60 * 60_000;
const key = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10).toUpperCase();
const WORK_END = 18 * 60;

export async function seedDemoCases(db: PrismaDb, c: Ctx): Promise<Record<string, number>> {
  const { clinicId, branchId, dentistId, receptionId } = c;
  const stats = { patients: 0, visits: 0, appointments: 0, charges: 0, documents: 0, loyaltyEntries: 0, odontograms: 0, bookingRequests: 0 };
  const today = utcToLima(new Date()).date;
  const day = (n: number, minutes: number) => limaToUtc(addDays(today, n), minutes);

  // ------------------------------------------------------------------ requisitos (los crea la agenda y los datos adicionales)
  const rooms: string[] = [];
  for (const name of ['Consultorio 1 (demo)', 'Consultorio 2 (demo)']) {
    const r = await db.room.findUnique({ where: { branchId_name: { branchId, name } } });
    if (!r) return stats;
    rooms.push(r.id);
  }
  const services: Record<string, { id: string; minutes: number; price: number }> = {};
  for (const name of ['Consulta (demo)', 'Limpieza dental (demo)', 'Control (demo)', 'Restauración (demo)', 'Endodoncia (demo)', 'Extracción (demo)', 'Sellante (demo)', 'Corona (demo)', 'Evaluación de implante (demo)']) {
    const s = await db.agendaService.findUnique({ where: { clinicId_name: { clinicId, name } } });
    if (!s) return stats; // faltan los datos base/adicionales: nada que ampliar
    services[name] = { id: s.id, minutes: s.durationMinutes, price: s.priceCents ?? 10_000 };
  }
  const defs: Record<string, string> = {};
  for (const code of ['DEMO-CONTROL', 'DEMO-LIMPIEZA', 'DEMO-RESTAURACION', 'DEMO-ENDODONCIA', 'DEMO-EXODONCIA', 'DEMO-SELLANTE', 'DEMO-CORONA']) {
    const def = await db.procedureDefinition.findUnique({ where: { clinicId_code: { clinicId, code } } });
    if (!def) return stats;
    defs[code] = def.id;
  }

  // ------------------------------------------------------------------ pacientes, representantes y consentimientos
  type IdType = 'DNI' | 'CE' | 'PASSPORT';
  const ensurePatient = async (s: { idType: IdType; id: string; first: string; last: string; second: string; birth: string; sex: 'FEMALE' | 'MALE'; mobile?: string; email?: string; inactive?: string }) => {
    const ident = prepareIdentifier({ type: s.idType as never, number: s.id });
    const found = await db.patientIdentifier.findFirst({ where: { clinicId, type: ident.type, number: ident.number, status: 'ACTIVE' }, select: { patientId: true } });
    if (found) return found.patientId;
    const contacts = prepareContacts([...(s.mobile ? [{ type: 'MOBILE' as never, value: s.mobile }] : []), ...(s.email ? [{ type: 'EMAIL' as never, value: s.email }] : [])]);
    stats.patients++;
    return db.$transaction(async (tx) => {
      const p = await tx.patient.create({
        data: { clinicId, firstName: s.first, lastName: s.last, secondLastName: s.second, birthDate: toDateOnly(s.birth), sex: s.sex, createdById: receptionId, createdBranchId: branchId, ...(s.inactive ? { status: 'INACTIVE' as const, statusReason: s.inactive } : {}) },
      });
      await tx.patientIdentifier.create({ data: identifierRow(clinicId, p.id, ident, receptionId) });
      for (const ct of contacts) await tx.patientContact.create({ data: contactRow(clinicId, p.id, ct, receptionId) });
      return p.id;
    });
  };
  const guardianOf = async (dni: string, first: string, second: string, mobile: string) =>
    (await db.guardian.findFirst({ where: { clinicId, identifierType: 'DNI', identifierNumber: dni } })) ??
    db.guardian.create({ data: { clinicId, firstName: first, lastName: 'Demo', secondLastName: second, identifierType: 'DNI', identifierNumber: dni, mobile, createdById: receptionId } });
  const link = async (patientId: string, guardianId: string, relationship: 'MOTHER' | 'FATHER') => {
    if (!(await db.patientGuardian.findFirst({ where: { patientId, guardianId, status: 'ACTIVE' } })))
      await db.patientGuardian.create({ data: { clinicId, patientId, guardianId, relationship, isPrimary: true, activeKey: `${patientId}|${guardianId}`, createdById: receptionId } });
  };
  const consent = async (patientId: string, type: 'CLINICAL' | 'LOYALTY' | 'MARKETING', by: 'PATIENT' | 'GUARDIAN' = 'PATIENT', guardianId?: string) => {
    const activeKey = `${patientId}|${type}`;
    if (await db.patientConsent.findUnique({ where: { activeKey } })) return;
    await db.patientConsent.create({ data: { clinicId, patientId, type, activeKey, grantedBy: by, guardianId: guardianId ?? null, documentTitle: type === 'CLINICAL' ? 'Consentimiento informado (demo)' : `Autorización ${type} (demo)`, documentVersion: 'demo-1.0', grantedAt: new Date(), createdById: receptionId } });
  };
  const relate = async (patientId: string) => {
    const activeKey = `${patientId}|${dentistId}|*`;
    return (await db.patientCareRelationship.findUnique({ where: { activeKey } })) ??
      db.patientCareRelationship.create({ data: { clinicId, patientId, dentistUserId: dentistId, source: 'ASSIGNMENT', activeKey, reason: 'Asignación de demostración', createdById: receptionId } });
  };

  const P = {
    gestante: await ensurePatient({ idType: 'DNI', id: '90000021', first: 'Sofía', last: 'Demo', second: 'Gestante', birth: '1996-04-20', sex: 'FEMALE', mobile: '900000021', email: 'sofia.demo@apidental.test' }),
    hipertenso: await ensurePatient({ idType: 'DNI', id: '90000022', first: 'Ernesto', last: 'Demo', second: 'Hipertenso', birth: '1961-09-12', sex: 'MALE', mobile: '900000022' }),
    caries: await ensurePatient({ idType: 'DNI', id: '90000023', first: 'Bruno', last: 'Demo', second: 'Caries', birth: '2016-12-09', sex: 'MALE' }),
    ortodoncia: await ensurePatient({ idType: 'DNI', id: '90000024', first: 'Lucas', last: 'Demo', second: 'Ortodoncia', birth: '2011-03-08', sex: 'MALE', email: 'lucas.demo@apidental.test' }),
    protesis: await ensurePatient({ idType: 'DNI', id: '90000025', first: 'Hortensia', last: 'Demo', second: 'Prótesis', birth: '1944-06-21', sex: 'FEMALE', mobile: '900000025' }),
    extranjero: await ensurePatient({ idType: 'CE', id: 'CE0000026', first: 'Jonathan', last: 'Demo', second: 'Extranjero', birth: '1990-10-03', sex: 'MALE', mobile: '900000026', email: 'jonathan.demo@apidental.test' }),
    pasaporte: await ensurePatient({ idType: 'PASSPORT', id: 'XA0000027', first: 'Ingrid', last: 'Demo', second: 'Pasaporte', birth: '1987-02-14', sex: 'FEMALE', email: 'ingrid.demo@example.test' }),
    inactivo: await ensurePatient({ idType: 'DNI', id: '90000028', first: 'Gustavo', last: 'Demo', second: 'Inactivo', birth: '1975-08-30', sex: 'MALE', mobile: '900000028', inactive: 'Se mudó de ciudad (demostración); puede reactivarse' }),
    bruxismo: await ensurePatient({ idType: 'DNI', id: '90000029', first: 'Pamela', last: 'Demo', second: 'Bruxismo', birth: '1990-01-25', sex: 'FEMALE', mobile: '900000029', email: 'pamela.demo@apidental.test' }),
    reciente: await ensurePatient({ idType: 'DNI', id: '90000032', first: 'Nicole', last: 'Demo', second: 'Reciente', birth: '2001-05-11', sex: 'FEMALE', mobile: '900000032', email: 'nicole.demo@apidental.test' }),
  };
  const gBruno = await guardianOf('90000030', 'Marta', 'Madre', '900000030');
  const gLucas = await guardianOf('90000031', 'Raúl', 'Padre', '900000031');
  await link(P.caries, gBruno.id, 'MOTHER');
  await link(P.ortodoncia, gLucas.id, 'FATHER');
  for (const t of ['CLINICAL', 'LOYALTY', 'MARKETING'] as const) await consent(P.gestante, t);
  await consent(P.hipertenso, 'CLINICAL'); await consent(P.hipertenso, 'LOYALTY');
  await consent(P.caries, 'CLINICAL', 'GUARDIAN', gBruno.id); await consent(P.caries, 'LOYALTY', 'GUARDIAN', gBruno.id);
  await consent(P.ortodoncia, 'CLINICAL', 'GUARDIAN', gLucas.id); await consent(P.ortodoncia, 'LOYALTY', 'GUARDIAN', gLucas.id);
  for (const t of ['CLINICAL', 'LOYALTY', 'MARKETING'] as const) await consent(P.protesis, t);
  await consent(P.extranjero, 'CLINICAL'); await consent(P.extranjero, 'MARKETING');
  await consent(P.pasaporte, 'MARKETING'); // sin consentimiento clínico a propósito: muestra el aviso
  await consent(P.inactivo, 'CLINICAL');
  await consent(P.bruxismo, 'CLINICAL'); await consent(P.bruxismo, 'LOYALTY');
  for (const t of ['CLINICAL', 'LOYALTY', 'MARKETING'] as const) await consent(P.reciente, t);
  const rel: Record<string, string> = {};
  for (const [k, id] of Object.entries(P)) rel[k] = (await relate(id)).id;

  // ------------------------------------------------------------------ helpers clínicos (mismos patrones que demo-extra)
  const openVisit = async (patientId: string, relationshipId: string, reason: string, startedAt: Date) => {
    const existing = await db.clinicalVisit.findFirst({ where: { patientId, reason } });
    if (existing) return { visit: existing, fresh: false };
    const last = await db.clinicalVisit.aggregate({ where: { patientId }, _max: { visitNumber: true } });
    const visit = await db.clinicalVisit.create({
      data: { clinicId, patientId, branchId, dentistUserId: dentistId, careRelationshipId: relationshipId, visitNumber: (last._max.visitNumber ?? 0) + 1, openKey: `${patientId}|${dentistId}`, reason, startedAt, createdById: dentistId },
    });
    stats.visits++;
    return { visit, fresh: true };
  };
  const diagnose = async (patientId: string, visitId: string, description: string, certainty: 'PRESUMPTIVE' | 'DEFINITIVE') => {
    const itemId = crypto.randomUUID();
    await db.clinicalDiagnosis.create({ data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, description, certainty, changeKind: 'CREATED', createdById: dentistId } });
  };
  const procedure = async (patientId: string, visitId: string, code: string, notes: string, performedAt: Date) => {
    const def = await db.procedureDefinition.findUniqueOrThrow({ where: { id: defs[code]! } });
    const itemId = crypto.randomUUID();
    const v1 = await db.clinicalProcedure.create({
      data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes, performedAt, changeKind: 'CREATED', createdById: dentistId },
    });
    await db.clinicalProcedure.update({ where: { id: v1.id }, data: { currentKey: null } });
    await db.clinicalProcedure.create({
      data: { clinicId, patientId, visitId, itemId, version: 2, supersedesId: v1.id, currentKey: itemId, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes, performedAt: v1.performedAt, status: 'CLOSED', closedAt: performedAt, closureConsent: def.requiresClinicalConsent ? 'GRANTED' : 'NOT_REQUIRED', changeKind: 'CLOSED', createdById: dentistId },
    });
  };
  const note = async (patientId: string, visitId: string, body: string, followUp: string | null, stage: 'closed' | 'corrected') => {
    const itemId = crypto.randomUUID();
    const v1 = await db.clinicalNote.create({ data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, visitKey: visitId, status: 'DRAFT', body, followUp, changeKind: 'CREATED', createdById: dentistId } });
    await db.clinicalNote.update({ where: { id: v1.id }, data: { currentKey: null, visitKey: null } });
    const v2 = await db.clinicalNote.create({
      data: { clinicId, patientId, visitId, itemId, version: 2, supersedesId: v1.id, currentKey: itemId, visitKey: visitId, status: 'CLOSED', body, followUp, changeKind: 'CLOSED', contentHash: noteContentHash({ itemId, version: 2, visitId, patientId, body, followUp }), closedAt: new Date(), reauthProofId: DEMO_PROOF_ID, createdById: dentistId },
    });
    if (stage !== 'corrected') return;
    await db.clinicalNote.update({ where: { id: v2.id }, data: { currentKey: null, visitKey: null } });
    const fixed = `${body} Aclaración posterior de demostración (dato ficticio).`;
    await db.clinicalNote.create({
      data: { clinicId, patientId, visitId, itemId, version: 3, supersedesId: v2.id, currentKey: itemId, visitKey: visitId, status: 'CLOSED', body: fixed, followUp, changeKind: 'CORRECTED', changeReason: 'Se agrega una aclaración de ejemplo', contentHash: noteContentHash({ itemId, version: 3, visitId, patientId, body: fixed, followUp }), closedAt: new Date(), reauthProofId: DEMO_PROOF_ID, createdById: dentistId },
    });
  };
  /** Antecedente (o alergia) crítico o no, con su alerta visible para el equipo. */
  const background = async (patientId: string, kind: 'BACKGROUND' | 'ALLERGY', label: string, condition: string, category: string, o: { critical?: boolean; severity?: 'MILD' | 'MODERATE' | 'SEVERE'; alert?: { severity: 'INFO' | 'WARNING' | 'CRITICAL'; text: string } } = {}) => {
    if (await db.clinicalHistoryEntry.findFirst({ where: { patientId, kind, label } })) return;
    const itemId = crypto.randomUUID();
    await db.clinicalHistoryEntry.create({ data: { clinicId, patientId, itemId, version: 1, currentKey: itemId, kind, label, condition, category, severity: o.severity ?? 'MODERATE', isCritical: o.critical ?? false, source: 'PATIENT', observations: 'Dato ficticio para la demostración.', changeKind: 'CREATED', createdById: dentistId } });
    if (kind === 'ALLERGY' && !(await db.clinicalAllergyAssessment.findFirst({ where: { patientId } })))
      await db.clinicalAllergyAssessment.create({ data: { clinicId, patientId, version: 1, currentKey: patientId, status: 'ALLERGIES_RECORDED', assessedOn: new Date(), source: 'PROFESSIONAL', changeKind: 'CREATED', automatic: true, createdById: dentistId } });
    if (o.alert) {
      const alertId = crypto.randomUUID();
      await db.clinicalAlert.create({ data: { clinicId, patientId, itemId: alertId, version: 1, currentKey: alertId, severity: o.alert.severity, text: o.alert.text, source: 'PROFESSIONAL', changeKind: 'CREATED', createdById: dentistId } });
    }
  };
  const odontogram = async (patientId: string, dentition: Dentition, steps: { teeth: Record<string, unknown>; notes?: string; kind: 'CREATED' | 'UPDATED' }[]) => {
    if ((await db.clinicalOdontogram.count({ where: { patientId } })) > 0) return;
    let prev: { id: string; version: number } | null = null;
    for (const st of steps) {
      const data = normalizeOdontogram({ schema: 'apidental.odontogram', schemaVersion: 1, teeth: st.teeth, ...(st.notes ? { notes: st.notes } : {}) }, dentition);
      const base = { clinicId, patientId, dentition, data: data as never, changeKind: st.kind, changeReason: null, createdById: dentistId };
      if (prev) await db.clinicalOdontogram.update({ where: { id: prev.id }, data: { currentKey: null } });
      const draft: { id: string; version: number } = await db.clinicalOdontogram.create({ data: { ...base, version: (prev?.version ?? 0) + 1, supersedesId: prev?.id ?? null, currentKey: patientId, status: 'DRAFT' } });
      await db.clinicalOdontogram.update({ where: { id: draft.id }, data: { currentKey: null } });
      const version = draft.version + 1;
      prev = await db.clinicalOdontogram.create({
        data: { ...base, version, supersedesId: draft.id, currentKey: patientId, status: 'CLOSED', contentHash: odontogramHash({ patientId, version, dentition, data }), closedAt: new Date() },
      });
    }
    stats.odontograms++;
  };

  // ------------------------------------------------------------------ agenda (futuras en el primer hueco libre del horario de trabajo)
  const firstFree = async (n: number, minute: number, minutes: number): Promise<{ start: Date; room: 0 | 1 }> => {
    for (let m = minute; m + minutes <= WORK_END; m += 15) {
      const start = day(n, m);
      const starts = slotStarts(start, addMinutes(start, minutes));
      if (await db.appointmentSlot.findFirst({ where: { resourceKind: 'DENTIST', resourceId: dentistId, slotStart: { in: starts } }, select: { ownerId: true } })) continue;
      for (const room of [0, 1] as const) {
        if (!(await db.appointmentSlot.findFirst({ where: { resourceKind: 'ROOM', resourceId: rooms[room]!, slotStart: { in: starts } }, select: { ownerId: true } }))) return { start, room };
      }
    }
    throw new Error('No hay un hueco libre para la cita de demostración');
  };
  /** Pasadas (n < 0) a la hora indicada; futuras en el primer hueco libre desde esa hora. */
  const appointment = async (patientId: string, service: string, n: number, minute: number, status: ApptStatus, note: string, o: { visitId?: string; reason?: string } = {}) => {
    const text = `${NOTE} ${note}`;
    const found = await db.appointment.findFirst({ where: { clinicId, patientId, notes: text } });
    if (found) return { appt: found, start: found.startsAt };
    const svc = services[service]!;
    let start = day(n, minute);
    let roomIdx: 0 | 1 = 0;
    const holds = status === 'RESERVED' || status === 'CONFIRMED';
    if (holds) ({ start, room: roomIdx } = await firstFree(n, minute, svc.minutes));
    const end = addMinutes(start, svc.minutes);
    const roomId = rooms[roomIdx]!;
    const appt = await db.$transaction(async (tx) => {
      const a = await tx.appointment.create({
        data: {
          clinicId, branchId, patientId, dentistUserId: dentistId, roomId, serviceId: svc.id, startsAt: start, endsAt: end, status, notes: text, createdById: receptionId,
          ...(status === 'CONFIRMED' ? { confirmedById: receptionId, confirmedAt: new Date() } : {}),
          ...(status === 'ATTENDED' ? { visitId: o.visitId!, attendedAt: start } : {}),
          ...(status === 'CANCELLED' ? { cancelReason: o.reason ?? 'Cancelada por el paciente (demostración)' } : {}),
          ...(status === 'NO_SHOW' ? { noShowReason: o.reason ?? 'No asistió (demostración)' } : {}),
        },
      });
      if (holds) {
        const starts = slotStarts(start, end);
        await tx.appointmentSlot.createMany({
          data: [
            ...starts.map((slotStart) => ({ resourceKind: 'DENTIST' as const, resourceId: dentistId, slotStart, ownerKind: 'APPOINTMENT' as const, ownerId: a.id, clinicId })),
            ...starts.map((slotStart) => ({ resourceKind: 'ROOM' as const, resourceId: roomId, slotStart, ownerKind: 'APPOINTMENT' as const, ownerId: a.id, clinicId })),
          ],
        });
      }
      return a;
    });
    stats.appointments++;
    return { appt, start };
  };

  // ------------------------------------------------------------------ caja, comprobantes y puntos (simulados)
  const charge = async (patientId: string, a: { id: string } | null, description: string, amountCents: number, createdAt: Date, state: { kind: 'PAID'; method: Money } | { kind: 'PENDING' }) => {
    const found = a ? await db.charge.findFirst({ where: { clinicId, appointmentId: a.id } }) : await db.charge.findFirst({ where: { clinicId, patientId, description, appointmentId: null } });
    if (found) return found;
    stats.charges++;
    return db.charge.create({
      data: {
        clinicId, branchId, patientId, appointmentId: a?.id ?? null, appointmentKey: a ? a.id : null, description, amountCents, createdById: receptionId, createdAt,
        ...(state.kind === 'PAID' ? { status: 'PAID' as const, paymentMethod: state.method, paidAt: addMinutes(createdAt, 20), paidById: receptionId, version: 2 } : {}),
      },
    });
  };
  const outbox = async (kind: 'BILLING_EMIT' | 'LOYALTY_ACCRUE' | 'REVIEW_REQUEST', aggregateType: string, aggregateId: string, idempotencyKey: string, status: 'PENDING' | 'DONE' | 'SKIPPED', noteText: string, at: Date) => {
    if (await db.integrationOutbox.findUnique({ where: { idempotencyKey } })) return;
    await db.integrationOutbox.create({ data: { clinicId, kind, aggregateType, aggregateId, idempotencyKey, status, attempts: 1, note: noteText, createdAt: at, processedAt: status === 'PENDING' ? null : at, nextAttemptAt: status === 'PENDING' ? new Date(Date.now() + hours(1)) : at } });
  };
  const settle = async (ch: { id: string; patientId: string; amountCents: number; paidAt: Date | null }) => {
    const at = ch.paidAt ?? new Date();
    const hasLoyalty = Boolean(await db.patientConsent.findUnique({ where: { activeKey: `${ch.patientId}|LOYALTY` } }));
    const hasMarketing = Boolean(await db.patientConsent.findUnique({ where: { activeKey: `${ch.patientId}|MARKETING` } }));
    const points = Math.floor(ch.amountCents / POINTS_PER_CENTS);
    const lk = `loyalty-accrue:${ch.id}`;
    if (!hasLoyalty) await outbox('LOYALTY_ACCRUE', 'Charge', ch.id, lk, 'SKIPPED', 'Sin autorización de fidelización del paciente', at);
    else {
      if (!(await db.mockLoyaltyEntry.findUnique({ where: { idempotencyKey: lk } }))) { await db.mockLoyaltyEntry.create({ data: { clinicId, patientRef: ch.patientId, kind: 'ACCRUAL', points, reason: 'Pago de atención (simulado)', idempotencyKey: lk, createdAt: at } }); stats.loyaltyEntries++; }
      await outbox('LOYALTY_ACCRUE', 'Charge', ch.id, lk, 'DONE', `+${points} puntos (simulado)`, at);
    }
    const rk = `review:${ch.id}`;
    if (!hasMarketing) await outbox('REVIEW_REQUEST', 'Charge', ch.id, rk, 'SKIPPED', 'Sin autorización de comunicaciones (marketing) del paciente', at);
    else {
      if (!(await db.mockReviewRequest.findUnique({ where: { idempotencyKey: rk } }))) await db.mockReviewRequest.create({ data: { clinicId, patientRef: ch.patientId, idempotencyKey: rk, createdAt: at } });
      await outbox('REVIEW_REQUEST', 'Charge', ch.id, rk, 'DONE', 'Solicitud enviada (simulada)', at);
    }
  };
  const redeem = async (patientId: string, points: number, tag: string, at: Date) => {
    const k = `redeem:demo#:${tag}`;
    if (await db.mockLoyaltyEntry.findUnique({ where: { idempotencyKey: k } })) return;
    await db.mockLoyaltyEntry.create({ data: { clinicId, patientRef: patientId, kind: 'REDEMPTION', points, reason: 'Canje en caja (simulado)', idempotencyKey: k, createdAt: at } });
    stats.loyaltyEntries++;
  };
  const bonus = async (patientId: string, points: number, tag: string, reason: string, at: Date) => {
    const k = `accrue:demo#:${tag}`;
    if (await db.mockLoyaltyEntry.findUnique({ where: { idempotencyKey: k } })) return;
    await db.mockLoyaltyEntry.create({ data: { clinicId, patientRef: patientId, kind: 'ACCRUAL', points, reason, idempotencyKey: k, createdAt: at } });
    stats.loyaltyEntries++;
  };
  type DocSpec = { n: number; type: 'BOLETA' | 'FACTURA'; scenario: Scenario; final: 'ISSUED' | 'SENT' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NEEDS_RECONCILIATION'; customer?: { docType: string; docNumber: string; name: string } };
  const document = async (ch: { id: string; patientId: string; amountCents: number; createdAt: Date }, d: DocSpec) => {
    const idem = `doc:${ch.id}:${d.n}`;
    if (await db.billingDocument.findUnique({ where: { idempotencyKey: idem } })) return;
    const series = d.type === 'BOLETA' ? 'BD01' : 'FD01';
    let customer = d.customer;
    if (!customer) {
      const p = await db.patient.findUniqueOrThrow({ where: { id: ch.patientId } });
      const ident = await db.patientIdentifier.findFirst({ where: { patientId: ch.patientId, clinicId, status: 'ACTIVE' } });
      customer = { docType: ident?.type ?? 'DNI', docNumber: ident?.number ?? '-', name: [p.firstName, p.lastName, p.secondLastName].filter(Boolean).join(' ') };
    }
    const at = addMinutes(ch.createdAt, 30 + d.n);
    const ref = `DEMO-${key(idem)}`;
    const doc = await db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT IGNORE INTO billing_counters (clinic_id, series, last) VALUES (${clinicId}, ${series}, 0)`;
      await tx.$queryRaw`SELECT last FROM billing_counters WHERE clinic_id = ${clinicId} AND series = ${series} FOR UPDATE`;
      await tx.$executeRaw`UPDATE billing_counters SET last = last + 1 WHERE clinic_id = ${clinicId} AND series = ${series}`;
      const counter = await tx.$queryRaw<{ last: number }[]>`SELECT last FROM billing_counters WHERE clinic_id = ${clinicId} AND series = ${series}`;
      return tx.billingDocument.create({
        data: {
          clinicId, chargeId: ch.id, type: d.type, series, number: Number(counter[0]!.last), status: d.final, customerName: customer!.name, customerDocType: customer!.docType, customerDocNumber: customer!.docNumber,
          amountCents: ch.amountCents, igvCents: igvOf(ch.amountCents), demoMark: DOC_DEMO_MARK, idempotencyKey: idem, activeKey: d.final === 'REJECTED' ? null : ch.id,
          scenario: d.scenario, attempts: 1, lastAttemptAt: at, createdById: receptionId, createdAt: ch.createdAt,
          ...(d.final === 'ISSUED' ? { providerRef: ref, issuedAt: at } : {}),
          ...(d.final === 'SENT' ? { providerRef: ref } : {}),
          ...(d.final === 'REJECTED' ? { rejectionReason: 'Rechazo simulado: el dato del cliente no pasó la validación de demostración.' } : {}),
        },
      });
    });
    stats.documents++;
    const record = { ISSUED: ['ISSUED', { providerRef: ref, issuedAt: at.toISOString() }], SENT: ['PENDING', { providerRef: ref }], REJECTED: ['REJECTED', { reason: 'Rechazo simulado: el dato del cliente no pasó la validación de demostración.' }],
      RETRYABLE_ERROR: ['TRANSIENT', null], NEEDS_RECONCILIATION: ['ISSUED', { providerRef: ref, issuedAt: at.toISOString() }] } as const;
    const [state, result] = record[d.final];
    await db.mockProviderRecord.upsert({ where: { idempotencyKey: idem }, update: {}, create: { idempotencyKey: idem, kind: 'BILLING', state, attempts: 1, ...(result ? { result: result as never } : {}) } });
    const notes = { ISSUED: 'Emitido (simulado)', SENT: 'Enviado; falta la confirmación (concilie)', REJECTED: 'Rechazado (simulado)', RETRYABLE_ERROR: 'Servicio no disponible (simulado); se reintentará', NEEDS_RECONCILIATION: 'Sin respuesta a tiempo; requiere conciliación' } as const;
    await outbox('BILLING_EMIT', 'BillingDocument', doc.id, `emit:${idem}`, d.final === 'RETRYABLE_ERROR' ? 'PENDING' : 'DONE', notes[d.final], at);
  };

  // ------------------------------------------------------------------ una atención cerrada completa (visita, diagnóstico, procedimiento, evolución, cita)
  type Case = keyof typeof P;
  const attended = async (patient: Case, daysAgo: number, minuteOfDay: number, service: string, body: { diagnosis: string; certainty?: 'PRESUMPTIVE' | 'DEFINITIVE'; code: string; procedureNotes: string; stage?: 'closed' | 'corrected'; followUp?: string }) => {
    const start = day(-daysAgo, minuteOfDay);
    const { visit, fresh } = await openVisit(P[patient], rel[patient]!, `${REASON} ${service} (${patient}, hace ${daysAgo} días)`, start);
    if (fresh) {
      await diagnose(P[patient], visit.id, body.diagnosis, body.certainty ?? 'DEFINITIVE');
      await procedure(P[patient], visit.id, body.code, body.procedureNotes, start);
      await note(P[patient], visit.id, `Evolución de demostración: ${body.diagnosis.toLowerCase()} (dato ficticio).`, body.followUp ?? null, body.stage ?? 'closed');
      await db.clinicalVisit.update({ where: { id: visit.id }, data: { status: 'CLOSED', openKey: null, closedAt: addMinutes(start, services[service]!.minutes), version: { increment: 1 } } });
    }
    const { appt } = await appointment(P[patient], service, -daysAgo, minuteOfDay, 'ATTENDED', `${service} atendida (${patient}, hace ${daysAgo} días)`, { visitId: visit.id });
    return { appt, start };
  };
  const price = (service: string) => services[service]!.price;

  // 1) Gestante, alergia a la penicilina y alerta: consulta pagada con tarjeta, control confirmado.
  {
    await background(P.gestante, 'ALLERGY', 'Penicilina (demo)', 'Erupción cutánea de ejemplo (ficticia)', 'Medicamento', { critical: true, severity: 'SEVERE', alert: { severity: 'WARNING', text: 'Alergia a la penicilina: evitar antibióticos relacionados (dato ficticio)' } });
    await background(P.gestante, 'BACKGROUND', 'Embarazo de 24 semanas (demo)', 'Control prenatal al día (dato ficticio)', 'Condición', { severity: 'MILD', alert: { severity: 'INFO', text: 'Paciente gestante: coordinar con su obstetra (dato ficticio)' } });
    const a = await attended('gestante', 6, 9 * 60 + 30, 'Consulta (demo)', { diagnosis: 'Gingivitis del embarazo leve', certainty: 'PRESUMPTIVE', code: 'DEMO-CONTROL', procedureNotes: 'Consulta de demostración; sin radiografías por el embarazo.', followUp: 'Control en cuatro semanas (ficticio).' });
    const ch = await charge(P.gestante, a.appt, 'Consulta (demo)', price('Consulta (demo)'), a.start, { kind: 'PAID', method: 'CARD' });
    await settle(ch);
    await document(ch, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    await odontogram(P.gestante, 'PERMANENT', [{ kind: 'CREATED', notes: 'Revisión durante el embarazo (dato ficticio).', teeth: { '26': { surfaces: { O: { state: 'CARIES' } } }, '36': { surfaces: { O: { state: 'RESTORATION' } } }, '46': { surfaces: { O: { state: 'RESTORATION' } } }, '11': { surfaces: { V: { state: 'OTHER', note: 'Inflamación gingival de demostración' } } } } }]);
    await appointment(P.gestante, 'Control (demo)', 3, 10 * 60, 'CONFIRMED', 'control de la gestante confirmado (gestante)');
  }
  // 2) Hipertenso, diabético y anticoagulado (alerta crítica): endodoncia (Yape/Plin) y corona (transferencia, factura).
  {
    await background(P.hipertenso, 'BACKGROUND', 'Hipertensión arterial (demo)', 'En tratamiento (dato ficticio)', 'Condición', { severity: 'MODERATE' });
    await background(P.hipertenso, 'BACKGROUND', 'Diabetes tipo 2 (demo)', 'Control con dieta y medicación (dato ficticio)', 'Condición', { severity: 'MODERATE' });
    await background(P.hipertenso, 'BACKGROUND', 'Anticoagulante oral (demo)', 'Riesgo de sangrado en procedimientos (dato ficticio)', 'Medicación', { critical: true, severity: 'SEVERE', alert: { severity: 'CRITICAL', text: 'Toma anticoagulante: coordinar con su médico antes de procedimientos con sangrado (dato ficticio)' } });
    const a1 = await attended('hipertenso', 18, 11 * 60, 'Endodoncia (demo)', { diagnosis: 'Necrosis pulpar en premolar (dato ficticio)', code: 'DEMO-ENDODONCIA', procedureNotes: 'Endodoncia de demostración con control de presión arterial.', stage: 'corrected', followUp: 'Colocar corona definitiva (ficticio).' });
    const c1 = await charge(P.hipertenso, a1.appt, 'Endodoncia (demo)', price('Endodoncia (demo)'), a1.start, { kind: 'PAID', method: 'YAPE_PLIN' });
    await settle(c1);
    await document(c1, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    const a2 = await attended('hipertenso', 7, 15 * 60, 'Corona (demo)', { diagnosis: 'Pieza tratada con endodoncia que requiere cobertura', code: 'DEMO-CORONA', procedureNotes: 'Corona de demostración (dato ficticio).', followUp: 'Revisar adaptación (ficticio).' });
    const c2 = await charge(P.hipertenso, a2.appt, 'Corona (demo)', price('Corona (demo)'), a2.start, { kind: 'PAID', method: 'TRANSFER' });
    await settle(c2);
    await document(c2, { n: 1, type: 'FACTURA', scenario: 'ISSUE', final: 'ISSUED', customer: { docType: 'RUC', docNumber: '20000000003', name: 'Comercial Ficticia de Prueba S.A.C.' } });
    await odontogram(P.hipertenso, 'PERMANENT', [{ kind: 'CREATED', notes: 'Endodoncia y corona de demostración (dato ficticio).', teeth: { '14': { marks: ['ENDODONTIC', 'CROWN'] }, '15': { surfaces: { D: { state: 'RESTORATION' } } }, '24': { marks: ['ENDODONTIC'] }, '36': { marks: ['CROWN'] }, '37': { surfaces: { O: { state: 'CARIES' } } }, '48': { status: 'ABSENT' } } }]);
    await appointment(P.hipertenso, 'Control (demo)', 6, 9 * 60, 'RESERVED', 'control tras la corona (hipertenso)');
  }
  // 3) Niño de 9 años con representante: caries múltiples y sellantes, dentición mixta.
  {
    const a1 = await attended('caries', 12, 16 * 60, 'Sellante (demo)', { diagnosis: 'Molares permanentes con fosas profundas', code: 'DEMO-SELLANTE', procedureNotes: 'Sellantes de demostración en primeros molares.', followUp: 'Control de sellantes en seis meses (ficticio).' });
    const c1 = await charge(P.caries, a1.appt, 'Sellante (demo)', price('Sellante (demo)'), a1.start, { kind: 'PAID', method: 'CASH' });
    await settle(c1);
    await document(c1, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED', customer: { docType: 'DNI', docNumber: '90000030', name: 'Marta Demo Madre' } });
    const a2 = await attended('caries', 3, 16 * 60 + 30, 'Restauración (demo)', { diagnosis: 'Caries en molares temporales', code: 'DEMO-RESTAURACION', procedureNotes: 'Restauraciones de demostración con el representante presente.' });
    await charge(P.caries, a2.appt, 'Restauración (demo)', price('Restauración (demo)'), a2.start, { kind: 'PENDING' });
    await odontogram(P.caries, 'MIXED', [{ kind: 'CREATED', notes: 'Caries múltiples en dentición mixta (dato ficticio).', teeth: { '16': { surfaces: { O: { state: 'SEALANT' } } }, '26': { surfaces: { O: { state: 'SEALANT' } } }, '36': { surfaces: { O: { state: 'SEALANT' } } }, '46': { surfaces: { O: { state: 'SEALANT' } } }, '54': { surfaces: { O: { state: 'CARIES' }, D: { state: 'CARIES' } } }, '64': { surfaces: { O: { state: 'CARIES' } } }, '75': { surfaces: { O: { state: 'RESTORATION' } } }, '85': { surfaces: { O: { state: 'CARIES' }, M: { state: 'CARIES' } } }, '12': { status: 'UNERUPTED' }, '22': { status: 'UNERUPTED' }, '11': { surfaces: { M: { state: 'FRACTURE', note: 'Golpe de demostración (ficticio)' } } } } }]);
    await appointment(P.caries, 'Restauración (demo)', 10, 16 * 60, 'RESERVED', 'segunda restauración del niño (caries)');
  }
  // 4) Adolescente en ortodoncia: controles mensuales, uno pendiente de pago.
  {
    const a1 = await attended('ortodoncia', 60, 15 * 60, 'Control (demo)', { diagnosis: 'Colocación de aparatología fija (dato ficticio)', code: 'DEMO-CONTROL', procedureNotes: 'Brackets de demostración colocados.', followUp: 'Control mensual (ficticio).' });
    const c1 = await charge(P.ortodoncia, a1.appt, 'Control (demo)', price('Control (demo)'), a1.start, { kind: 'PAID', method: 'CARD' });
    await settle(c1);
    await document(c1, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED', customer: { docType: 'DNI', docNumber: '90000031', name: 'Raúl Demo Padre' } });
    const a2 = await attended('ortodoncia', 30, 15 * 60, 'Control (demo)', { diagnosis: 'Control mensual de ortodoncia', code: 'DEMO-CONTROL', procedureNotes: 'Cambio de arco de demostración.', followUp: 'Siguiente control en un mes (ficticio).' });
    await charge(P.ortodoncia, a2.appt, 'Control (demo)', price('Control (demo)'), a2.start, { kind: 'PENDING' });
    const wires = { V: { state: 'OTHER', note: 'Bracket de demostración (ficticio)' } };
    await odontogram(P.ortodoncia, 'PERMANENT', [{ kind: 'CREATED', notes: 'Aparatología fija superior e inferior (dato ficticio).', teeth: { '13': { surfaces: wires }, '12': { surfaces: wires }, '11': { surfaces: wires }, '21': { surfaces: wires }, '22': { surfaces: wires }, '23': { surfaces: wires }, '33': { surfaces: wires }, '32': { surfaces: wires }, '31': { surfaces: wires }, '41': { surfaces: wires }, '42': { surfaces: wires }, '43': { surfaces: wires }, '16': { surfaces: { O: { state: 'SEALANT' } } }, '26': { surfaces: { O: { state: 'SEALANT' } } } } }]);
    await appointment(P.ortodoncia, 'Control (demo)', 5, 15 * 60, 'CONFIRMED', 'control mensual confirmado (ortodoncia)');
    await appointment(P.ortodoncia, 'Control (demo)', 35, 15 * 60, 'RESERVED', 'control mensual siguiente (ortodoncia)');
  }
  // 5) Adulta mayor desdentada parcial: prótesis, implante y restos radiculares; puntos acumulados y canjeados.
  {
    const a1 = await attended('protesis', 9, 10 * 60, 'Evaluación de implante (demo)', { diagnosis: 'Pérdida de piezas posteriores; evaluación para implante', certainty: 'PRESUMPTIVE', code: 'DEMO-CONTROL', procedureNotes: 'Evaluación de demostración con radiografía ficticia.', followUp: 'Decidir plan con la paciente (ficticio).' });
    const c1 = await charge(P.protesis, a1.appt, 'Evaluación de implante (demo)', price('Evaluación de implante (demo)'), a1.start, { kind: 'PAID', method: 'CASH' });
    await settle(c1);
    await document(c1, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    await bonus(P.protesis, 40, 'protesis-1', 'Bono por paciente recurrente (simulado)', addMinutes(a1.start, 60 * 24));
    await redeem(P.protesis, 20, 'protesis-1', addMinutes(a1.start, 60 * 24 * 4));
    await odontogram(P.protesis, 'PERMANENT', [{ kind: 'CREATED', notes: 'Desdentado parcial con prótesis e implante (dato ficticio).', teeth: { '18': { status: 'ABSENT' }, '17': { status: 'ABSENT' }, '16': { status: 'ABSENT' }, '15': { marks: ['PROSTHESIS'] }, '14': { marks: ['PROSTHESIS'] }, '13': { status: 'ROOT_REMNANT' }, '26': { status: 'IMPLANT', marks: ['CROWN'] }, '27': { status: 'ABSENT' }, '28': { status: 'ABSENT' }, '36': { status: 'ABSENT' }, '37': { status: 'ABSENT' }, '38': { status: 'ABSENT' }, '46': { status: 'ABSENT' }, '45': { marks: ['PROSTHESIS'] }, '44': { marks: ['PROSTHESIS'] }, '33': { surfaces: { V: { state: 'CARIES' } } } } }]);
    await appointment(P.protesis, 'Control (demo)', 4, 11 * 60, 'CONFIRMED', 'control de prótesis confirmado (prótesis)');
  }
  // 6) Extranjero con carné de extranjería: extracción pagada por transferencia, boleta con CE.
  {
    const a1 = await attended('extranjero', 5, 9 * 60, 'Extracción (demo)', { diagnosis: 'Tercer molar inferior con pericoronaritis (dato ficticio)', code: 'DEMO-EXODONCIA', procedureNotes: 'Extracción de demostración sin complicaciones.', followUp: 'Retirar puntos en una semana (ficticio).' });
    const ch = await charge(P.extranjero, a1.appt, 'Extracción (demo)', price('Extracción (demo)'), a1.start, { kind: 'PAID', method: 'TRANSFER' });
    await settle(ch);
    await document(ch, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    await odontogram(P.extranjero, 'PERMANENT', [{ kind: 'CREATED', notes: 'Tras la extracción del 48 (dato ficticio).', teeth: { '48': { status: 'ABSENT' }, '38': { status: 'UNERUPTED' }, '18': { status: 'UNERUPTED' }, '28': { status: 'UNERUPTED' }, '36': { surfaces: { O: { state: 'RESTORATION' } } } } }]);
    await appointment(P.extranjero, 'Control (demo)', 8, 9 * 60, 'RESERVED', 'control tras la extracción (extranjero)');
  }
  // 7) Pasaporte, sin celular (solo correo) y sin consentimiento clínico: se ve el aviso; una cita cancelada y una próxima.
  {
    await appointment(P.pasaporte, 'Consulta (demo)', -4, 14 * 60, 'CANCELLED', 'consulta cancelada por viaje (pasaporte)', { reason: 'Cancelada por el paciente: viaje (demostración)' });
    await appointment(P.pasaporte, 'Consulta (demo)', 2, 14 * 60, 'RESERVED', 'primera consulta, falta el consentimiento clínico (pasaporte)');
  }
  // 8) Paciente INACTIVO con historial cerrado (puede reactivarse): limpieza antigua pagada y comprobante emitido.
  {
    const a1 = await attended('inactivo', 90, 12 * 60, 'Limpieza dental (demo)', { diagnosis: 'Cálculo supragingival leve', code: 'DEMO-LIMPIEZA', procedureNotes: 'Profilaxis de demostración.', followUp: 'Control en seis meses (ficticio).' });
    const ch = await charge(P.inactivo, a1.appt, 'Limpieza dental (demo)', price('Limpieza dental (demo)'), a1.start, { kind: 'PAID', method: 'CASH' });
    await settle(ch);
    await document(ch, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    await odontogram(P.inactivo, 'PERMANENT', [{ kind: 'CREATED', notes: 'Última revisión antes de mudarse (dato ficticio).', teeth: { '16': { surfaces: { O: { state: 'RESTORATION' } } }, '26': { surfaces: { O: { state: 'RESTORATION' } } }, '38': { status: 'ABSENT' }, '48': { status: 'ABSENT' } } }]);
  }
  // 9) Bruxismo: tres visitas cerradas con evoluciones, fracturas y desgaste; comprobante enviado sin confirmar.
  {
    const a1 = await attended('bruxismo', 75, 10 * 60, 'Consulta (demo)', { diagnosis: 'Sospecha de bruxismo nocturno', certainty: 'PRESUMPTIVE', code: 'DEMO-CONTROL', procedureNotes: 'Consulta de demostración; se indica placa de descarga.', followUp: 'Evaluar la placa en un mes (ficticio).' });
    const c1 = await charge(P.bruxismo, a1.appt, 'Consulta (demo)', price('Consulta (demo)'), a1.start, { kind: 'PAID', method: 'YAPE_PLIN' });
    await settle(c1);
    await document(c1, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    const a2 = await attended('bruxismo', 40, 14 * 60, 'Restauración (demo)', { diagnosis: 'Fractura de cúspide por desgaste', code: 'DEMO-RESTAURACION', procedureNotes: 'Restauración de demostración en molar fracturado.', stage: 'corrected', followUp: 'Controlar la oclusión (ficticio).' });
    const c2 = await charge(P.bruxismo, a2.appt, 'Restauración (demo)', price('Restauración (demo)'), a2.start, { kind: 'PAID', method: 'CARD' });
    await settle(c2);
    await document(c2, { n: 1, type: 'BOLETA', scenario: 'PENDING', final: 'SENT' });
    await attended('bruxismo', 8, 11 * 60 + 30, 'Control (demo)', { diagnosis: 'Control de la placa de descarga', code: 'DEMO-CONTROL', procedureNotes: 'Ajuste de la placa de demostración.', stage: 'corrected', followUp: 'Control en tres meses (ficticio).' });
    await odontogram(P.bruxismo, 'PERMANENT', [
      { kind: 'CREATED', notes: 'Desgaste incisal y oclusal por bruxismo (dato ficticio).', teeth: { '11': { surfaces: { O: { state: 'OTHER', note: 'Desgaste incisal de demostración' } } }, '21': { surfaces: { O: { state: 'OTHER', note: 'Desgaste incisal de demostración' } } }, '16': { surfaces: { O: { state: 'FRACTURE' } } }, '36': { surfaces: { O: { state: 'FRACTURE' } } } } },
      { kind: 'UPDATED', notes: 'Se restaura la 36 y se agrega la fractura de la 46 (dato ficticio).', teeth: { '11': { surfaces: { O: { state: 'OTHER', note: 'Desgaste incisal de demostración' } } }, '21': { surfaces: { O: { state: 'OTHER', note: 'Desgaste incisal de demostración' } } }, '16': { surfaces: { O: { state: 'FRACTURE' } } }, '36': { surfaces: { O: { state: 'RESTORATION' } } }, '46': { surfaces: { O: { state: 'FRACTURE' }, D: { state: 'FRACTURE' } } } } },
    ]);
    await appointment(P.bruxismo, 'Control (demo)', 14, 10 * 60, 'CONFIRMED', 'control de la placa confirmado (bruxismo)');
  }
  // 10) Paciente nueva sin historial: cita mañana y solicitudes web (una pendiente de una persona aún no registrada, una rechazada).
  {
    await appointment(P.reciente, 'Consulta (demo)', 1, 9 * 60 + 30, 'RESERVED', 'primera consulta de mañana (reciente)');
    const hasRequests = async (reference: string) => Boolean(await db.bookingRequest.findUnique({ where: { reference } }));
    const request = async (reference: string, r: { first: string; last: string; second?: string; mobile: string; email?: string; service: string; desired: Date; createdAt: Date; notes?: string; rejected?: string }) => {
      if (await hasRequests(reference)) return;
      await db.bookingRequest.create({
        data: {
          reference, clinicId, branchId, serviceId: services[r.service]!.id, desiredStartsAt: r.desired, firstName: r.first, lastName: r.last, secondLastName: r.second ?? null,
          mobile: r.mobile, email: r.email ?? null, notes: r.notes ?? null, privacyAcceptedAt: r.createdAt, createdAt: r.createdAt,
          ...(r.rejected ? { status: 'REJECTED' as const, rejectReason: r.rejected, decidedById: receptionId, decidedAt: addMinutes(r.createdAt, 90) } : {}),
        },
      });
      stats.bookingRequests++;
    };
    await request('SOL-K7M3PQ', { first: 'Hugo', last: 'Demo', second: 'Web', mobile: '900000034', email: 'hugo.demo@example.test', service: 'Limpieza dental (demo)', desired: day(3, 11 * 60), createdAt: new Date(Date.now() - hours(3)), notes: 'Prefiero por la mañana (dato ficticio)' });
    await request('SOL-R4T9XW', { first: 'Nicole', last: 'Demo', second: 'Reciente', mobile: '900000032', email: 'nicole.demo@apidental.test', service: 'Consulta (demo)', desired: day(1, 9 * 60), createdAt: new Date(Date.now() - hours(30)), rejected: 'Ese horario no estaba libre; se le ofreció otro por teléfono (demostración)' });
  }

  return stats;
}
