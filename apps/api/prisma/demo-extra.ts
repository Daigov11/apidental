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
 * DATOS DE DEMOSTRACIÓN ADICIONALES de Clínica Demo (todo FICTICIO: apellido "Demo", documentos 9000001x, correos
 * @apidental.test, textos marcados como demostración; sin personas, teléfonos ni documentos reales). Solo desarrollo.
 *
 * Idempotente: cada elemento se busca antes de crearlo (por documento, motivo de visita, nota de cita, descripción de
 * cobro o clave de idempotencia); volver a ejecutar el seed no duplica nada. Escribe directamente en la base de datos
 * respetando sus CHECK y triggers, con los mismos estados y claves que producen los servicios reales en modo mock.
 *
 * Escenarios (ver el reporte del seed): niño (dentición temporal), niña (mixta), joven, adulta con alergia, adulto
 * mayor con implantes/prótesis, adulta mayor con atención abierta, adulto con endodoncia y una paciente nueva sin
 * consentimiento clínico. Cobros pagados con los cuatro medios, pendiente y anulado; comprobantes emitido, enviado
 * (pendiente de confirmación), rechazado, error reintentable y requiere conciliación; puntos, canjes y reseñas simulados.
 */
const NOTE = 'Demo+:';
const REASON = 'DEMO+:';

interface Ctx { clinicId: string; branchId: string; dentistId: string; receptionId: string; adminUserId: string }
type Money = 'CASH' | 'CARD' | 'YAPE_PLIN' | 'TRANSFER';
type Scenario = 'ISSUE' | 'PENDING' | 'REJECT' | 'ERROR_THEN_OK' | 'TIMEOUT';

const EXTRA_SERVICES = [
  ['Endodoncia (demo)', 90, 60_000], ['Extracción (demo)', 45, 18_000], ['Sellante (demo)', 30, 6_000],
  ['Corona (demo)', 60, 90_000], ['Evaluación de implante (demo)', 30, 15_000],
] as const;
const EXTRA_PROCEDURES = [
  { code: 'DEMO-ENDODONCIA', name: 'Endodoncia (demo)', consent: true },
  { code: 'DEMO-EXODONCIA', name: 'Extracción (demo)', consent: true },
  { code: 'DEMO-SELLANTE', name: 'Sellante (demo)', consent: false },
  { code: 'DEMO-CORONA', name: 'Corona (demo)', consent: true },
] as const;

const hours = (n: number) => n * 60 * 60_000;
const key = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10).toUpperCase();

export async function seedDemoExtra(db: PrismaDb, c: Ctx): Promise<Record<string, number>> {
  const { clinicId, branchId, dentistId, receptionId, adminUserId } = c;
  const stats = { patients: 0, visits: 0, appointments: 0, charges: 0, documents: 0, loyaltyEntries: 0, odontograms: 0 };
  const today = utcToLima(new Date()).date;
  const nowMinute = Math.ceil((Date.now() + 5 * 60_000) / 300_000) * 300_000;
  const day = (n: number, minutes: number) => limaToUtc(addDays(today, n), minutes);

  // ------------------------------------------------------------------ servicios, consultorios y catálogo
  const rooms: string[] = [];
  for (const name of ['Consultorio 1 (demo)', 'Consultorio 2 (demo)']) {
    const r = await db.room.findUnique({ where: { branchId_name: { branchId, name } } });
    if (!r) return stats; // la agenda base no existe: nada que ampliar
    rooms.push(r.id);
  }
  const specialty = await db.specialty.findUnique({ where: { clinicId_name: { clinicId, name: 'Odontología general (demo)' } } });
  const services: Record<string, { id: string; minutes: number; price: number }> = {};
  for (const [name, minutes, price] of EXTRA_SERVICES) {
    const s = (await db.agendaService.findUnique({ where: { clinicId_name: { clinicId, name } } })) ?? (await db.agendaService.create({ data: { clinicId, name, durationMinutes: minutes, priceCents: price, specialtyId: specialty?.id ?? null } }));
    services[name] = { id: s.id, minutes: s.durationMinutes, price: s.priceCents ?? price };
  }
  for (const name of ['Consulta (demo)', 'Limpieza dental (demo)', 'Control (demo)', 'Restauración (demo)']) {
    const s = await db.agendaService.findUnique({ where: { clinicId_name: { clinicId, name } } });
    if (!s) return stats;
    services[name] = { id: s.id, minutes: s.durationMinutes, price: s.priceCents ?? 10_000 };
  }
  const defs: Record<string, string> = {};
  for (const d of EXTRA_PROCEDURES) {
    const def = (await db.procedureDefinition.findUnique({ where: { clinicId_code: { clinicId, code: d.code } } })) ??
      (await db.procedureDefinition.create({ data: { clinicId, code: d.code, name: d.name, description: 'Procedimiento de demostración (dato ficticio)', requiresClinicalConsent: d.consent, createdById: adminUserId } }));
    defs[d.code] = def.id;
  }
  for (const code of ['DEMO-CONTROL', 'DEMO-LIMPIEZA', 'DEMO-RESTAURACION']) {
    const def = await db.procedureDefinition.findUnique({ where: { clinicId_code: { clinicId, code } } });
    if (def) defs[code] = def.id;
  }

  // ------------------------------------------------------------------ pacientes
  const ensurePatient = async (s: { dni: string; first: string; last: string; second: string; birth: string; sex: 'FEMALE' | 'MALE'; mobile: string; email?: string }) => {
    const id = prepareIdentifier({ type: 'DNI' as never, number: s.dni });
    const found = await db.patientIdentifier.findFirst({ where: { clinicId, type: id.type, number: id.number, status: 'ACTIVE' }, select: { patientId: true } });
    if (found) return found.patientId;
    const contacts = prepareContacts([{ type: 'MOBILE' as never, value: s.mobile }, ...(s.email ? [{ type: 'EMAIL' as never, value: s.email }] : [])]);
    stats.patients++;
    return db.$transaction(async (tx) => {
      const p = await tx.patient.create({ data: { clinicId, firstName: s.first, lastName: s.last, secondLastName: s.second, birthDate: toDateOnly(s.birth), sex: s.sex, createdById: receptionId } });
      await tx.patientIdentifier.create({ data: identifierRow(clinicId, p.id, id, receptionId) });
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
    santiago: await ensurePatient({ dni: '90000011', first: 'Santiago', last: 'Demo', second: 'Pequeño', birth: '2022-03-14', sex: 'MALE', mobile: '900000011' }),
    valentina: await ensurePatient({ dni: '90000012', first: 'Valentina', last: 'Demo', second: 'Mixta', birth: '2019-08-02', sex: 'FEMALE', mobile: '900000012' }),
    diego: await ensurePatient({ dni: '90000013', first: 'Diego', last: 'Demo', second: 'Joven', birth: '2005-11-23', sex: 'MALE', mobile: '900000013', email: 'diego.demo@apidental.test' }),
    andrea: await ensurePatient({ dni: '90000014', first: 'Andrea', last: 'Demo', second: 'Alergia', birth: '1992-02-09', sex: 'FEMALE', mobile: '900000014', email: 'andrea.demo@apidental.test' }),
    carlos: await ensurePatient({ dni: '90000015', first: 'Carlos', last: 'Demo', second: 'Implantes', birth: '1958-07-30', sex: 'MALE', mobile: '900000015' }),
    rosa: await ensurePatient({ dni: '90000016', first: 'Rosa', last: 'Demo', second: 'Mayor', birth: '1949-12-05', sex: 'FEMALE', mobile: '900000016' }),
    javier: await ensurePatient({ dni: '90000017', first: 'Javier', last: 'Demo', second: 'Endodoncia', birth: '1983-05-17', sex: 'MALE', mobile: '900000017', email: 'javier.demo@apidental.test' }),
    mariana: await ensurePatient({ dni: '90000018', first: 'Mariana', last: 'Demo', second: 'Nueva', birth: '2000-01-28', sex: 'FEMALE', mobile: '900000018' }),
  };
  const gSantiago = await guardianOf('90000019', 'Pedro', 'Padre', '900000019');
  const gValentina = await guardianOf('90000020', 'Elena', 'Madre', '900000020');
  await link(P.santiago, gSantiago.id, 'FATHER');
  await link(P.valentina, gValentina.id, 'MOTHER');
  await consent(P.santiago, 'CLINICAL', 'GUARDIAN', gSantiago.id);
  await consent(P.valentina, 'CLINICAL', 'GUARDIAN', gValentina.id);
  await consent(P.valentina, 'LOYALTY', 'GUARDIAN', gValentina.id);
  for (const t of ['CLINICAL', 'LOYALTY', 'MARKETING'] as const) await consent(P.diego, t);
  await consent(P.andrea, 'CLINICAL'); await consent(P.andrea, 'LOYALTY'); // sin marketing: la reseña se omite
  for (const t of ['CLINICAL', 'LOYALTY', 'MARKETING'] as const) await consent(P.carlos, t);
  await consent(P.rosa, 'CLINICAL'); // sin fidelización: la tarjeta muestra «no ha autorizado»
  for (const t of ['CLINICAL', 'LOYALTY', 'MARKETING'] as const) await consent(P.javier, t);
  // Mariana: sin consentimiento clínico a propósito (muestra el aviso y el bloqueo de cierre de procedimientos).
  await consent(P.mariana, 'MARKETING');
  const rel: Record<string, string> = {};
  for (const [k, id] of Object.entries(P)) rel[k] = (await relate(id)).id;

  // ------------------------------------------------------------------ helpers clínicos
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
  const procedure = async (patientId: string, visitId: string, code: string, notes: string, close: boolean, performedAt: Date) => {
    const def = await db.procedureDefinition.findUniqueOrThrow({ where: { id: defs[code]! } });
    const itemId = crypto.randomUUID();
    const v1 = await db.clinicalProcedure.create({
      data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes, performedAt, changeKind: 'CREATED', createdById: dentistId },
    });
    if (!close) return;
    await db.clinicalProcedure.update({ where: { id: v1.id }, data: { currentKey: null } });
    await db.clinicalProcedure.create({
      data: { clinicId, patientId, visitId, itemId, version: 2, supersedesId: v1.id, currentKey: itemId, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes, performedAt, status: 'CLOSED', closedAt: performedAt, closureConsent: def.requiresClinicalConsent ? 'GRANTED' : 'NOT_REQUIRED', changeKind: 'CLOSED', createdById: dentistId },
    });
  };
  const note = async (patientId: string, visitId: string, body: string, followUp: string | null, stage: 'draft' | 'closed' | 'corrected') => {
    const itemId = crypto.randomUUID();
    const v1 = await db.clinicalNote.create({ data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, visitKey: visitId, status: 'DRAFT', body, followUp, changeKind: 'CREATED', createdById: dentistId } });
    if (stage === 'draft') return;
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
  const allergy = async (patientId: string, label: string, reaction: string) => {
    if (await db.clinicalHistoryEntry.findFirst({ where: { patientId, kind: 'ALLERGY', label } })) return;
    const allergyId = crypto.randomUUID();
    await db.clinicalHistoryEntry.create({ data: { clinicId, patientId, itemId: allergyId, version: 1, currentKey: allergyId, kind: 'ALLERGY', label, condition: reaction, category: 'Medicamento', severity: 'SEVERE', isCritical: true, source: 'PATIENT', observations: 'Dato ficticio para la demostración.', changeKind: 'CREATED', createdById: dentistId } });
    if (!(await db.clinicalAllergyAssessment.findFirst({ where: { patientId } })))
      await db.clinicalAllergyAssessment.create({ data: { clinicId, patientId, version: 1, currentKey: patientId, status: 'ALLERGIES_RECORDED', assessedOn: new Date(), source: 'PROFESSIONAL', changeKind: 'CREATED', automatic: true, createdById: dentistId } });
    const alertId = crypto.randomUUID();
    await db.clinicalAlert.create({ data: { clinicId, patientId, itemId: alertId, version: 1, currentKey: alertId, severity: 'WARNING', text: 'Alergia registrada (dato ficticio de demostración)', source: 'PROFESSIONAL', changeKind: 'CREATED', createdById: dentistId } });
  };
  const odontogram = async (patientId: string, dentition: Dentition, steps: { teeth: Record<string, unknown>; notes?: string; kind: 'CREATED' | 'UPDATED'; close: boolean }[]) => {
    if ((await db.clinicalOdontogram.count({ where: { patientId } })) > 0) return;
    let prev: { id: string; version: number } | null = null;
    for (const st of steps) {
      const data = normalizeOdontogram({ schema: 'apidental.odontogram', schemaVersion: 1, teeth: st.teeth, ...(st.notes ? { notes: st.notes } : {}) }, dentition);
      const base = { clinicId, patientId, dentition, data: data as never, changeKind: st.kind, changeReason: null, createdById: dentistId };
      if (prev) await db.clinicalOdontogram.update({ where: { id: prev.id }, data: { currentKey: null } });
      const draft: { id: string; version: number } = await db.clinicalOdontogram.create({ data: { ...base, version: (prev?.version ?? 0) + 1, supersedesId: prev?.id ?? null, currentKey: patientId, status: 'DRAFT' } });
      prev = draft;
      if (!st.close) continue;
      await db.clinicalOdontogram.update({ where: { id: draft.id }, data: { currentKey: null } });
      const version = draft.version + 1;
      prev = await db.clinicalOdontogram.create({
        data: { ...base, version, supersedesId: draft.id, currentKey: patientId, status: 'CLOSED', contentHash: odontogramHash({ patientId, version, dentition, data }), closedAt: new Date() },
      });
    }
    stats.odontograms++;
  };

  // ------------------------------------------------------------------ agenda
  const appointment = async (patientId: string, service: string, start: Date, status: 'RESERVED' | 'CONFIRMED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW', note: string, o: { visitId?: string; reason?: string; room?: 0 | 1 } = {}) => {
    const text = `${NOTE} ${note}`;
    const found = await db.appointment.findFirst({ where: { clinicId, patientId, notes: text } });
    if (found) return found;
    const svc = services[service]!;
    const end = addMinutes(start, svc.minutes);
    const roomId = rooms[o.room ?? 0]!;
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
      if (status === 'RESERVED' || status === 'CONFIRMED') {
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
    return appt;
  };

  // ------------------------------------------------------------------ caja, comprobantes, puntos y reseñas (simulados)
  const charge = async (patientId: string, a: { id: string } | null, description: string, amountCents: number, createdAt: Date, state: { kind: 'PAID'; method: Money } | { kind: 'PENDING' } | { kind: 'VOIDED'; reason: string }) => {
    const found = a
      ? await db.charge.findFirst({ where: { clinicId, appointmentId: a.id } })
      : await db.charge.findFirst({ where: { clinicId, patientId, description, appointmentId: null } });
    if (found) return found;
    stats.charges++;
    return db.charge.create({
      data: {
        clinicId, branchId, patientId, appointmentId: a?.id ?? null, appointmentKey: a && state.kind !== 'VOIDED' ? a.id : null, description, amountCents, createdById: receptionId, createdAt,
        ...(state.kind === 'PAID' ? { status: 'PAID' as const, paymentMethod: state.method, paidAt: addMinutes(createdAt, 20), paidById: receptionId, version: 2 } : {}),
        ...(state.kind === 'VOIDED' ? { status: 'VOIDED' as const, voidReason: state.reason, version: 2 } : {}),
      },
    });
  };
  const outbox = async (kind: 'BILLING_EMIT' | 'LOYALTY_ACCRUE' | 'REVIEW_REQUEST', aggregateType: string, aggregateId: string, idempotencyKey: string, status: 'PENDING' | 'DONE' | 'SKIPPED' | 'FAILED', noteText: string, at: Date, attempts = 1) => {
    if (await db.integrationOutbox.findUnique({ where: { idempotencyKey } })) return;
    await db.integrationOutbox.create({ data: { clinicId, kind, aggregateType, aggregateId, idempotencyKey, status, attempts, note: noteText, createdAt: at, processedAt: status === 'PENDING' ? null : at, nextAttemptAt: status === 'PENDING' ? new Date(Date.now() + hours(1)) : at } });
  };
  /** Puntos y reseña de un cobro pagado, igual que el procesador de la cola (se omiten sin autorización). */
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
    const k = `redeem:demo+:${tag}`;
    if (await db.mockLoyaltyEntry.findUnique({ where: { idempotencyKey: k } })) return;
    await db.mockLoyaltyEntry.create({ data: { clinicId, patientRef: patientId, kind: 'REDEMPTION', points, reason: 'Canje en caja (simulado)', idempotencyKey: k, createdAt: at } });
    stats.loyaltyEntries++;
  };
  const bonus = async (patientId: string, points: number, tag: string, reason: string, at: Date) => {
    const k = `accrue:demo+:${tag}`;
    if (await db.mockLoyaltyEntry.findUnique({ where: { idempotencyKey: k } })) return;
    await db.mockLoyaltyEntry.create({ data: { clinicId, patientRef: patientId, kind: 'ACCRUAL', points, reason, idempotencyKey: k, createdAt: at } });
    stats.loyaltyEntries++;
  };
  type DocSpec = {
    n: number; type: 'BOLETA' | 'FACTURA'; scenario: Scenario; final: 'ISSUED' | 'SENT' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NEEDS_RECONCILIATION';
    customer?: { docType: string; docNumber: string; name: string };
  };
  /** Comprobante simulado en el estado final que dejaría el flujo real (emisión → cola → proveedor simulado). */
  const document = async (ch: { id: string; patientId: string; amountCents: number; createdAt: Date }, d: DocSpec) => {
    const idem = `doc:${ch.id}:${d.n}`;
    if (await db.billingDocument.findUnique({ where: { idempotencyKey: idem } })) return;
    const series = d.type === 'BOLETA' ? 'BD01' : 'FD01';
    let customer = d.customer;
    if (!customer) {
      const p = await db.patient.findUniqueOrThrow({ where: { id: ch.patientId } });
      const ident = await db.patientIdentifier.findFirst({ where: { patientId: ch.patientId, clinicId, status: 'ACTIVE', type: 'DNI' } });
      customer = { docType: 'DNI', docNumber: ident?.number ?? '-', name: [p.firstName, p.lastName, p.secondLastName].filter(Boolean).join(' ') };
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
    // Lo que «recordaría» el proveedor simulado (así reintentar y conciliar funcionan como en el flujo real).
    const record = { ISSUED: ['ISSUED', { providerRef: ref, issuedAt: at.toISOString() }], SENT: ['PENDING', { providerRef: ref }], REJECTED: ['REJECTED', { reason: 'Rechazo simulado: el dato del cliente no pasó la validación de demostración.' }],
      RETRYABLE_ERROR: ['TRANSIENT', null], NEEDS_RECONCILIATION: ['ISSUED', { providerRef: ref, issuedAt: at.toISOString() }] } as const;
    const [state, result] = record[d.final];
    await db.mockProviderRecord.upsert({ where: { idempotencyKey: idem }, update: {}, create: { idempotencyKey: idem, kind: 'BILLING', state, attempts: 1, ...(result ? { result: result as never } : {}) } });
    const notes = { ISSUED: 'Emitido (simulado)', SENT: 'Enviado; falta la confirmación (concilie)', REJECTED: 'Rechazado (simulado)', RETRYABLE_ERROR: 'Servicio no disponible (simulado); se reintentará', NEEDS_RECONCILIATION: 'Sin respuesta a tiempo; requiere conciliación' } as const;
    await outbox('BILLING_EMIT', 'BillingDocument', doc.id, `emit:${idem}`, d.final === 'RETRYABLE_ERROR' ? 'PENDING' : 'DONE', notes[d.final], at);
  };

  // ------------------------------------------------------------------ escenarios
  const attended = async (patient: keyof typeof P, daysAgo: number, minuteOfDay: number, service: string, body: { diagnosis: string; certainty?: 'PRESUMPTIVE' | 'DEFINITIVE'; procedure?: { code: string; notes: string }; stage: 'draft' | 'closed' | 'corrected'; open?: boolean; followUp?: string }) => {
    const start = day(-daysAgo, minuteOfDay);
    const { visit, fresh } = await openVisit(P[patient], rel[patient]!, `${REASON} ${service} (${patient})`, start);
    if (fresh) {
      await diagnose(P[patient], visit.id, body.diagnosis, body.certainty ?? 'DEFINITIVE');
      if (body.procedure) await procedure(P[patient], visit.id, body.procedure.code, body.procedure.notes, !body.open, start);
      await note(P[patient], visit.id, `Evolución de demostración: ${body.diagnosis.toLowerCase()} (dato ficticio).`, body.followUp ?? null, body.stage);
      if (!body.open) await db.clinicalVisit.update({ where: { id: visit.id }, data: { status: 'CLOSED', openKey: null, closedAt: addMinutes(start, services[service]!.minutes), version: { increment: 1 } } });
    }
    const appt = await appointment(P[patient], service, start, 'ATTENDED', `${service} atendida (${patient})`, { visitId: visit.id });
    return { appt, start };
  };
  const money = (service: string) => services[service]!.price;

  // 1) Santiago (4 años, dentición temporal, representante): control pagado en efectivo, comprobante emitido.
  {
    const { appt, start } = await attended('santiago', 8, 9 * 60, 'Control (demo)', { diagnosis: 'Caries inicial en molares temporales', procedure: { code: 'DEMO-CONTROL', notes: 'Control de demostración con el representante presente.' }, stage: 'closed', followUp: 'Control en seis meses (ficticio).' });
    const ch = await charge(P.santiago, appt, 'Control (demo)', money('Control (demo)'), start, { kind: 'PAID', method: 'CASH' });
    await settle(ch);
    await document(ch, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED', customer: { docType: 'DNI', docNumber: '90000019', name: 'Pedro Demo Padre' } });
    await odontogram(P.santiago, 'PRIMARY', [{ kind: 'CREATED', close: true, notes: 'Dentición temporal de demostración (dato ficticio).', teeth: { '55': { surfaces: { O: { state: 'CARIES' } } }, '54': { surfaces: { O: { state: 'RESTORATION' }, D: { state: 'RESTORATION' } } }, '64': { surfaces: { O: { state: 'SEALANT' } } }, '74': { status: 'ROOT_REMNANT' }, '85': { surfaces: { O: { state: 'CARIES' }, M: { state: 'CARIES' } } }, '51': { surfaces: { V: { state: 'FRACTURE', note: 'Golpe de demostración (ficticio)' } } } } }]);
    await appointment(P.santiago, 'Limpieza dental (demo)', day(2, 9 * 60), 'RESERVED', 'limpieza del niño con su papá (Santiago)', { room: 1 });
  }
  // 2) Valentina (7 años, dentición mixta): sellantes pagados con tarjeta; odontograma con dos versiones.
  {
    const { appt, start } = await attended('valentina', 15, 15 * 60, 'Sellante (demo)', { diagnosis: 'Molares permanentes recién erupcionados', procedure: { code: 'DEMO-SELLANTE', notes: 'Sellantes de demostración en molares.' }, stage: 'closed', followUp: 'Control de sellantes en seis meses (ficticio).' });
    const ch = await charge(P.valentina, appt, 'Sellante (demo)', money('Sellante (demo)'), start, { kind: 'PAID', method: 'CARD' });
    await settle(ch);
    await document(ch, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED', customer: { docType: 'DNI', docNumber: '90000020', name: 'Elena Demo Madre' } });
    await odontogram(P.valentina, 'MIXED', [
      { kind: 'CREATED', close: true, notes: 'Primera revisión de demostración (dato ficticio).', teeth: { '16': { surfaces: { O: { state: 'SEALANT' } } }, '26': { surfaces: { O: { state: 'SEALANT' } } }, '55': { surfaces: { O: { state: 'CARIES' } } }, '75': { status: 'ABSENT' }, '12': { status: 'UNERUPTED' }, '22': { status: 'UNERUPTED' } } },
      { kind: 'UPDATED', close: true, notes: 'Se agregan los sellantes inferiores y la restauración temporal (dato ficticio).', teeth: { '16': { surfaces: { O: { state: 'SEALANT' } } }, '26': { surfaces: { O: { state: 'SEALANT' } } }, '36': { surfaces: { O: { state: 'SEALANT' } } }, '46': { surfaces: { O: { state: 'SEALANT' } } }, '55': { surfaces: { O: { state: 'RESTORATION' } } }, '65': { surfaces: { O: { state: 'RESTORATION' }, M: { state: 'RESTORATION' } } }, '75': { status: 'ABSENT' }, '12': { status: 'UNERUPTED' }, '22': { status: 'UNERUPTED' } } },
    ]);
    await appointment(P.valentina, 'Control (demo)', day(9, 16 * 60), 'RESERVED', 'control de sellantes (Valentina)');
  }
  // 3) Diego (joven): limpieza pagada en efectivo; ausente reciente y próxima cita.
  {
    const { appt, start } = await attended('diego', 6, 11 * 60, 'Limpieza dental (demo)', { diagnosis: 'Gingivitis leve por placa', certainty: 'PRESUMPTIVE', procedure: { code: 'DEMO-LIMPIEZA', notes: 'Profilaxis de demostración.' }, stage: 'closed', followUp: 'Reforzar higiene (ficticio).' });
    const ch = await charge(P.diego, appt, 'Limpieza dental (demo)', money('Limpieza dental (demo)'), start, { kind: 'PAID', method: 'CASH' });
    await settle(ch);
    await document(ch, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    await odontogram(P.diego, 'PERMANENT', [{ kind: 'CREATED', close: true, notes: 'Cordales por erupcionar (dato ficticio).', teeth: { '18': { status: 'UNERUPTED' }, '28': { status: 'UNERUPTED' }, '38': { status: 'UNERUPTED' }, '48': { status: 'UNERUPTED' }, '36': { surfaces: { O: { state: 'CARIES' }, D: { state: 'CARIES' } } }, '46': { surfaces: { O: { state: 'CARIES' } } }, '16': { surfaces: { O: { state: 'SEALANT' } } }, '26': { surfaces: { O: { state: 'SEALANT' } } }, '11': { surfaces: { M: { state: 'FRACTURE' } } } } }]);
    await appointment(P.diego, 'Restauración (demo)', day(-3, 17 * 60), 'NO_SHOW', 'restauración a la que no asistió (Diego)', { reason: 'No asistió (demostración)' });
    await appointment(P.diego, 'Restauración (demo)', day(3, 17 * 60), 'RESERVED', 'restauración reprogramada (Diego)', { room: 1 });
  }
  // 4) Andrea (alergia crítica): dos atenciones; comprobantes «requiere conciliación» y «enviado».
  {
    await allergy(P.andrea, 'Anestésico local (demo)', 'Reacción de ejemplo (ficticia)');
    const a1 = await attended('andrea', 21, 10 * 60, 'Consulta (demo)', { diagnosis: 'Caries de esmalte en premolares', procedure: { code: 'DEMO-CONTROL', notes: 'Consulta de demostración; se registra la alergia.' }, stage: 'closed' });
    const c1 = await charge(P.andrea, a1.appt, 'Consulta (demo)', money('Consulta (demo)'), a1.start, { kind: 'PAID', method: 'CARD' });
    await settle(c1);
    await document(c1, { n: 1, type: 'BOLETA', scenario: 'TIMEOUT', final: 'NEEDS_RECONCILIATION' });
    const a2 = await attended('andrea', 2, 14 * 60, 'Restauración (demo)', { diagnosis: 'Restauración de premolar', procedure: { code: 'DEMO-RESTAURACION', notes: 'Restauración de demostración sin anestésico local (dato ficticio).' }, stage: 'corrected' });
    const c2 = await charge(P.andrea, a2.appt, 'Restauración (demo)', money('Restauración (demo)'), a2.start, { kind: 'PAID', method: 'TRANSFER' });
    await settle(c2);
    await document(c2, { n: 1, type: 'BOLETA', scenario: 'PENDING', final: 'SENT' });
    await odontogram(P.andrea, 'PERMANENT', [
      { kind: 'CREATED', close: true, teeth: { '37': { surfaces: { O: { state: 'CARIES' }, M: { state: 'CARIES' } } }, '15': { surfaces: { D: { state: 'OTHER', note: 'Mancha de demostración' } } }, '24': { marks: ['ENDODONTIC', 'CROWN'] } } },
      { kind: 'UPDATED', close: true, notes: 'Se restaura la 37 (dato ficticio).', teeth: { '37': { surfaces: { O: { state: 'RESTORATION' }, M: { state: 'RESTORATION' } } }, '47': { surfaces: { O: { state: 'RESTORATION' } } }, '15': { surfaces: { D: { state: 'OTHER', note: 'Mancha de demostración' } } }, '24': { marks: ['ENDODONTIC', 'CROWN'] } } },
    ]);
    await appointment(P.andrea, 'Control (demo)', new Date(nowMinute + hours(2)), 'CONFIRMED', 'control de hoy confirmado (Andrea)', { room: 1 });
  }
  // 5) Carlos (adulto mayor, implantes y prótesis): corona pagada por transferencia; factura rechazada y reemitida.
  {
    const { appt, start } = await attended('carlos', 10, 9 * 60 + 30, 'Corona (demo)', { diagnosis: 'Pieza tratada con endodoncia que requiere cobertura', procedure: { code: 'DEMO-CORONA', notes: 'Corona de demostración (dato ficticio).' }, stage: 'corrected', followUp: 'Revisar adaptación en dos semanas (ficticio).' });
    const ch = await charge(P.carlos, appt, 'Corona (demo)', money('Corona (demo)'), start, { kind: 'PAID', method: 'TRANSFER' });
    await settle(ch);
    const empresa = { docType: 'RUC', docNumber: '20000000001', name: 'Clínica Ficticia de Prueba S.A.C.' };
    await document(ch, { n: 1, type: 'FACTURA', scenario: 'REJECT', final: 'REJECTED', customer: empresa });
    await document(ch, { n: 2, type: 'FACTURA', scenario: 'ISSUE', final: 'ISSUED', customer: { ...empresa, docNumber: '20000000002' } });
    await bonus(P.carlos, 60, 'carlos-1', 'Bono por paciente recurrente (simulado)', addMinutes(start, 60 * 24));
    await redeem(P.carlos, 50, 'carlos-1', addMinutes(start, 60 * 24 * 3));
    await odontogram(P.carlos, 'PERMANENT', [{ kind: 'CREATED', close: true, notes: 'Implantes y prótesis de demostración (dato ficticio).', teeth: { '16': { status: 'ABSENT' }, '17': { status: 'IMPLANT', marks: ['CROWN'] }, '14': { marks: ['CROWN', 'ENDODONTIC'] }, '15': { marks: ['PROSTHESIS'] }, '25': { marks: ['PROSTHESIS'] }, '26': { status: 'ROOT_REMNANT' }, '36': { marks: ['CROWN'] }, '37': { surfaces: { O: { state: 'RESTORATION' } } }, '38': { status: 'ABSENT' }, '46': { status: 'ABSENT' }, '48': { status: 'ABSENT' } } }]);
    await appointment(P.carlos, 'Control (demo)', day(5, 9 * 60), 'CONFIRMED', 'control tras la corona confirmado (Carlos)');
  }
  // 6) Rosa (adulta mayor): atención de hoy abierta con evolución en borrador, cobro pendiente y odontograma en borrador.
  {
    const start = new Date(nowMinute - hours(3));
    const { visit, fresh } = await openVisit(P.rosa, rel['rosa']!, `${REASON} Consulta (demo) (rosa, abierta)`, start);
    if (fresh) {
      await diagnose(P.rosa, visit.id, 'Resto radicular y pérdida de piezas por evaluar', 'PRESUMPTIVE');
      await procedure(P.rosa, visit.id, 'DEMO-EXODONCIA', 'Extracción de demostración en curso (dato ficticio).', false, start);
      await note(P.rosa, visit.id, 'Borrador de demostración: falta completar la evolución (dato ficticio).', null, 'draft');
    }
    const appt = await appointment(P.rosa, 'Consulta (demo)', start, 'ATTENDED', 'consulta de hoy en curso (Rosa)', { visitId: visit.id });
    await charge(P.rosa, appt, 'Consulta (demo)', money('Consulta (demo)'), start, { kind: 'PENDING' });
    await odontogram(P.rosa, 'PERMANENT', [
      { kind: 'CREATED', close: true, notes: 'Pérdida múltiple de piezas (dato ficticio).', teeth: { '18': { status: 'ABSENT' }, '17': { status: 'ABSENT' }, '16': { status: 'ABSENT' }, '26': { status: 'ABSENT' }, '27': { status: 'ABSENT' }, '28': { status: 'ABSENT' }, '36': { status: 'ABSENT' }, '37': { status: 'ABSENT' }, '46': { status: 'ABSENT' }, '47': { status: 'ABSENT' }, '11': { marks: ['CROWN', 'PROSTHESIS'] }, '21': { marks: ['CROWN', 'PROSTHESIS'] }, '13': { status: 'ROOT_REMNANT' }, '33': { surfaces: { V: { state: 'CARIES' } } } } },
      { kind: 'UPDATED', close: false, notes: 'Borrador en curso durante la atención (dato ficticio).', teeth: { '18': { status: 'ABSENT' }, '17': { status: 'ABSENT' }, '16': { status: 'ABSENT' }, '26': { status: 'ABSENT' }, '27': { status: 'ABSENT' }, '28': { status: 'ABSENT' }, '36': { status: 'ABSENT' }, '37': { status: 'ABSENT' }, '46': { status: 'ABSENT' }, '47': { status: 'ABSENT' }, '11': { marks: ['CROWN', 'PROSTHESIS'] }, '21': { marks: ['CROWN', 'PROSTHESIS'] }, '13': { status: 'ROOT_REMNANT' }, '33': { surfaces: { V: { state: 'CARIES' }, O: { state: 'CARIES' } } }, '43': { surfaces: { V: { state: 'CARIES' } } } } },
    ]);
    await appointment(P.rosa, 'Control (demo)', day(-5, 11 * 60), 'CANCELLED', 'control cancelado (Rosa)', { reason: 'Cancelada por el paciente (demostración)' });
    await appointment(P.rosa, 'Control (demo)', day(7, 10 * 60), 'RESERVED', 'control de seguimiento (Rosa)');
  }
  // 7) Javier (endodoncia): pago con Yape; comprobante con error reintentable; puntos canjeados; ausencia previa.
  {
    const a1 = await attended('javier', 30, 16 * 60, 'Consulta (demo)', { diagnosis: 'Dolor persistente en molar inferior', certainty: 'PRESUMPTIVE', procedure: { code: 'DEMO-CONTROL', notes: 'Consulta de demostración.' }, stage: 'closed' });
    const c1 = await charge(P.javier, a1.appt, 'Consulta (demo)', money('Consulta (demo)'), a1.start, { kind: 'PAID', method: 'CASH' });
    await settle(c1);
    await document(c1, { n: 1, type: 'BOLETA', scenario: 'ISSUE', final: 'ISSUED' });
    const a2 = await attended('javier', 4, 10 * 60, 'Endodoncia (demo)', { diagnosis: 'Pulpitis irreversible (dato ficticio)', procedure: { code: 'DEMO-ENDODONCIA', notes: 'Endodoncia de demostración en una sesión.' }, stage: 'closed', followUp: 'Colocar corona definitiva (ficticio).' });
    const c2 = await charge(P.javier, a2.appt, 'Endodoncia (demo)', money('Endodoncia (demo)'), a2.start, { kind: 'PAID', method: 'YAPE_PLIN' });
    await settle(c2);
    await document(c2, { n: 1, type: 'BOLETA', scenario: 'ERROR_THEN_OK', final: 'RETRYABLE_ERROR' });
    await redeem(P.javier, 30, 'javier-1', addMinutes(a2.start, 60 * 24));
    await odontogram(P.javier, 'PERMANENT', [{ kind: 'CREATED', close: true, notes: 'Endodoncia y restauraciones de demostración (dato ficticio).', teeth: { '46': { marks: ['ENDODONTIC', 'CROWN'] }, '36': { surfaces: { O: { state: 'RESTORATION' }, M: { state: 'RESTORATION' } } }, '25': { marks: ['ENDODONTIC'] }, '14': { surfaces: { O: { state: 'CARIES' } } }, '24': { surfaces: { D: { state: 'CARIES' } } }, '48': { status: 'ABSENT' } } }]);
    await appointment(P.javier, 'Consulta (demo)', day(-12, 12 * 60), 'NO_SHOW', 'consulta a la que no asistió (Javier)', { reason: 'No asistió (demostración)' });
    await appointment(P.javier, 'Corona (demo)', new Date(nowMinute + hours(3)), 'RESERVED', 'corona definitiva de hoy (Javier)');
  }
  // 8) Mariana (nueva, sin consentimiento clínico): cita de mañana, cita cancelada y un cobro anulado por error.
  {
    await appointment(P.mariana, 'Consulta (demo)', day(1, 8 * 60), 'RESERVED', 'primera consulta, falta el consentimiento clínico (Mariana)');
    await appointment(P.mariana, 'Consulta (demo)', day(-2, 13 * 60), 'CANCELLED', 'consulta cancelada (Mariana)', { reason: 'Cancelada por el paciente (demostración)' });
    await charge(P.mariana, null, 'Consulta (demo): cobro registrado por error', money('Consulta (demo)'), new Date(Date.now() - hours(26)), { kind: 'VOIDED', reason: 'Registrado por error de digitación (demostración)' });
  }

  return stats;
}
