import { hashPassword } from '../src/common/utils/password.js';
import { noteContentHash } from '../src/clinical/note-hash.js';
import type { PrismaDb } from '../src/prisma/client.js';
import { assignmentKey } from '../src/users/assignment-key.js';

/**
 * DATOS DE DEMOSTRACIÓN de Clínica Demo. TODO es ficticio: nombres con apellido "Demo", documentos 9000000x,
 * correos @apidental.test (dominio reservado, no existe), textos marcados como "demostración". No hay personas, DNI,
 * teléfonos, correos, fotografías, direcciones ni historias reales. Solo en desarrollo (nunca en producción).
 *
 * Permiten mostrar el flujo completo: paciente → alerta/alergia → visita → diagnóstico → procedimiento → evolución:
 *  - Lucía Demo Adulta  : visita CERRADA con evolución CORREGIDA (consentimiento vigente, procedimiento realizado).
 *  - Mateo Demo Menor   : visita ABIERTA con la evolución en BORRADOR.
 *  - Jorge Demo Repetido: visita ABIERTA, evolución CERRADA y un procedimiento que NO se puede cerrar por falta de
 *                         consentimiento clínico (para mostrar el aviso).
 * Las evoluciones sembradas no tienen prueba de reautenticación real (es contenido de ejemplo): usan un identificador
 * de demostración fijo.
 */
export const DEMO_PROOF_ID = '00000000-0000-4000-8000-00000000d3a0';
export const DEMO_MARK = 'DEMO';

export const DEMO_STAFF = [
  { key: 'dentist', email: 'odontologa.demo@apidental.test', firstName: 'Valeria', lastName: 'Demo (odontóloga)', role: 'DENTIST', scope: 'branch' },
  { key: 'assistant', email: 'asistente.demo@apidental.test', firstName: 'Andrés', lastName: 'Demo (asistente)', role: 'ASSISTANT', scope: 'branch' },
  { key: 'reception', email: 'recepcion.demo@apidental.test', firstName: 'Rosa', lastName: 'Demo (recepción)', role: 'RECEPTIONIST', scope: 'clinic' },
  { key: 'director', email: 'director.demo@apidental.test', firstName: 'Daniel', lastName: 'Demo (director clínico)', role: 'CLINICAL_DIRECTOR', scope: 'clinic' },
] as const;

export const DEMO_CATALOG = [
  { code: 'DEMO-CONTROL', name: 'Control de rutina (demo)', requiresClinicalConsent: false },
  { code: 'DEMO-LIMPIEZA', name: 'Limpieza dental (demo)', requiresClinicalConsent: false },
  { code: 'DEMO-RESTAURACION', name: 'Restauración dental (demo)', requiresClinicalConsent: true },
] as const;

interface Ctx {
  clinicId: string;
  branchId: string;
  adminUserId: string;
  password: string;
}

export async function seedDemoClinical(db: PrismaDb, ctx: Ctx): Promise<{ users: Record<string, string>; patients: Record<string, string> }> {
  const { clinicId, branchId, adminUserId } = ctx;
  const passwordHash = await hashPassword(ctx.password);

  // --- equipo ficticio (el administrador de desarrollo otorga el rol de odontólogo; recepción asigna los pacientes) ---
  const users: Record<string, string> = {};
  for (const s of DEMO_STAFF) {
    const user = (await db.user.findUnique({ where: { email: s.email } })) ?? (await db.user.create({ data: { email: s.email, passwordHash, firstName: s.firstName, lastName: s.lastName } }));
    users[s.key] = user.id;
    const role = await db.role.findUniqueOrThrow({ where: { code: s.role } });
    const grant = { roleId: role.id, clinicId, branchId: s.scope === 'branch' ? branchId : null };
    await db.userAssignment.upsert({
      where: { assignmentKey: assignmentKey(user.id, grant) },
      update: { status: 'ACTIVE' },
      create: { userId: user.id, ...grant, assignmentKey: assignmentKey(user.id, grant), grantedById: adminUserId },
    });
  }
  const dentistId = users['dentist']!;
  const receptionId = users['reception']!;

  // --- catálogo de procedimientos de ejemplo ---
  const defs: Record<string, string> = {};
  for (const c of DEMO_CATALOG) {
    const def =
      (await db.procedureDefinition.findUnique({ where: { clinicId_code: { clinicId, code: c.code } } })) ??
      (await db.procedureDefinition.create({ data: { clinicId, code: c.code, name: c.name, description: 'Procedimiento de demostración (dato ficticio)', requiresClinicalConsent: c.requiresClinicalConsent, createdById: adminUserId } }));
    defs[c.code] = def.id;
  }

  const patientOf = async (dni: string): Promise<string | null> =>
    (await db.patientIdentifier.findFirst({ where: { clinicId, type: 'DNI', number: dni, status: 'ACTIVE' }, select: { patientId: true } }))?.patientId ?? null;
  const patients: Record<string, string> = {};
  const lucia = await patientOf('90000001');
  const mateo = await patientOf('90000002');
  const jorge = await patientOf('90000004');
  if (!lucia || !mateo || !jorge) return { users, patients };
  Object.assign(patients, { lucia, mateo, jorge });

  const relate = async (patientId: string) => {
    const activeKey = `${patientId}|${dentistId}|*`;
    return (
      (await db.patientCareRelationship.findUnique({ where: { activeKey } })) ??
      db.patientCareRelationship.create({ data: { clinicId, patientId, dentistUserId: dentistId, source: 'ASSIGNMENT', activeKey, reason: 'Asignación de demostración', createdById: receptionId } })
    );
  };

  // ---- helpers de escritura que respetan las reglas de la base de datos ----
  const openVisit = async (patientId: string, relationshipId: string, reason: string) => {
    const existing = await db.clinicalVisit.findFirst({ where: { patientId, reason } });
    if (existing) return { visit: existing, fresh: false };
    const last = await db.clinicalVisit.aggregate({ where: { patientId }, _max: { visitNumber: true } });
    const visit = await db.clinicalVisit.create({
      data: { clinicId, patientId, branchId, dentistUserId: dentistId, careRelationshipId: relationshipId, visitNumber: (last._max.visitNumber ?? 0) + 1, openKey: `${patientId}|${dentistId}`, reason, createdById: dentistId },
    });
    return { visit, fresh: true };
  };
  const diagnose = async (patientId: string, visitId: string, description: string, certainty: 'PRESUMPTIVE' | 'DEFINITIVE') => {
    const itemId = crypto.randomUUID();
    await db.clinicalDiagnosis.create({ data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, description, certainty, changeKind: 'CREATED', createdById: dentistId } });
  };
  const procedure = async (patientId: string, visitId: string, code: string, notes: string, close: boolean) => {
    const def = await db.procedureDefinition.findUniqueOrThrow({ where: { id: defs[code]! } });
    const itemId = crypto.randomUUID();
    const v1 = await db.clinicalProcedure.create({
      data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes, performedAt: new Date(), changeKind: 'CREATED', createdById: dentistId },
    });
    if (close) {
      await db.clinicalProcedure.update({ where: { id: v1.id }, data: { currentKey: null } });
      await db.clinicalProcedure.create({
        data: { clinicId, patientId, visitId, itemId, version: 2, supersedesId: v1.id, currentKey: itemId, definitionId: def.id, definitionCode: def.code, definitionName: def.name, dentistUserId: dentistId, notes, performedAt: v1.performedAt, status: 'CLOSED', closedAt: new Date(), closureConsent: def.requiresClinicalConsent ? 'GRANTED' : 'NOT_REQUIRED', changeKind: 'CLOSED', createdById: dentistId },
      });
    }
  };
  const note = async (patientId: string, visitId: string, body: string, followUp: string | null, stage: 'draft' | 'closed') => {
    const itemId = crypto.randomUUID();
    const v1 = await db.clinicalNote.create({ data: { clinicId, patientId, visitId, itemId, version: 1, currentKey: itemId, visitKey: visitId, status: 'DRAFT', body, followUp, changeKind: 'CREATED', createdById: dentistId } });
    if (stage === 'draft') return { itemId, row: v1 };
    await db.clinicalNote.update({ where: { id: v1.id }, data: { currentKey: null, visitKey: null } });
    const v2 = await db.clinicalNote.create({
      data: { clinicId, patientId, visitId, itemId, version: 2, supersedesId: v1.id, currentKey: itemId, visitKey: visitId, status: 'CLOSED', body, followUp, changeKind: 'CLOSED', contentHash: noteContentHash({ itemId, version: 2, visitId, patientId, body, followUp }), closedAt: new Date(), reauthProofId: DEMO_PROOF_ID, createdById: dentistId },
    });
    return { itemId, row: v2 };
  };
  const closeVisit = (visitId: string) => db.clinicalVisit.update({ where: { id: visitId }, data: { status: 'CLOSED', openKey: null, closedAt: new Date(), version: { increment: 1 } } });

  // ---- 1) Lucía: alergia crítica + aviso, visita cerrada, procedimiento realizado, evolución corregida ----
  {
    const rel = await relate(lucia);
    const { visit, fresh } = await openVisit(lucia, rel.id, `${DEMO_MARK}: visita de ejemplo (cerrada)`);
    if (fresh) {
      const allergyId = crypto.randomUUID();
      await db.clinicalHistoryEntry.create({
        data: { clinicId, patientId: lucia, itemId: allergyId, version: 1, currentKey: allergyId, kind: 'ALLERGY', label: 'Alergia a un material ficticio (demostración)', condition: 'Reacción de ejemplo', category: 'Material', severity: 'MODERATE', isCritical: true, source: 'PATIENT', observations: 'Dato ficticio para la demostración.', changeKind: 'CREATED', createdById: dentistId },
      });
      await db.clinicalAllergyAssessment.create({ data: { clinicId, patientId: lucia, version: 1, currentKey: lucia, status: 'ALLERGIES_RECORDED', assessedOn: new Date(), source: 'PROFESSIONAL', changeKind: 'CREATED', automatic: true, createdById: dentistId } });
      const alertId = crypto.randomUUID();
      await db.clinicalAlert.create({
        data: { clinicId, patientId: lucia, itemId: alertId, version: 1, currentKey: alertId, severity: 'INFO', text: 'Aviso de demostración (dato ficticio)', source: 'PROFESSIONAL', changeKind: 'CREATED', createdById: dentistId },
      });
      await diagnose(lucia, visit.id, 'Diagnóstico de demostración (dato ficticio)', 'DEFINITIVE');
      await procedure(lucia, visit.id, 'DEMO-RESTAURACION', 'Procedimiento de demostración realizado (dato ficticio).', true);
      const n = await note(lucia, visit.id, 'Evolución de demostración: paciente ficticio atendido sin incidentes (dato ficticio).', 'Control de demostración en unos días (ficticio).', 'closed');
      await closeVisit(visit.id);
      // corrección posterior: nueva versión enlazada, con motivo
      const prev = n.row;
      await db.clinicalNote.update({ where: { id: prev.id }, data: { currentKey: null, visitKey: null } });
      const body = 'Evolución de demostración (corregida): paciente ficticio atendido sin incidentes; se agrega una aclaración de ejemplo (dato ficticio).';
      await db.clinicalNote.create({
        data: { clinicId, patientId: lucia, visitId: visit.id, itemId: n.itemId, version: 3, supersedesId: prev.id, currentKey: n.itemId, visitKey: visit.id, status: 'CLOSED', body, followUp: prev.followUp, changeKind: 'CORRECTED', changeReason: 'Se agrega una aclaración de ejemplo', contentHash: noteContentHash({ itemId: n.itemId, version: 3, visitId: visit.id, patientId: lucia, body, followUp: prev.followUp }), closedAt: new Date(), reauthProofId: DEMO_PROOF_ID, createdById: dentistId },
      });
    }
  }

  // ---- 2) Mateo: visita abierta con evolución en borrador ----
  {
    const rel = await relate(mateo);
    const { visit, fresh } = await openVisit(mateo, rel.id, `${DEMO_MARK}: visita de ejemplo (abierta, borrador)`);
    if (fresh) {
      await diagnose(mateo, visit.id, 'Diagnóstico presuntivo de demostración (dato ficticio)', 'PRESUMPTIVE');
      await procedure(mateo, visit.id, 'DEMO-CONTROL', 'Control de demostración en curso (dato ficticio).', false);
      await note(mateo, visit.id, 'Borrador de demostración: aún falta completar la evolución (dato ficticio).', null, 'draft');
    }
  }

  // ---- 3) Jorge: visita abierta, evolución cerrada y un procedimiento bloqueado por falta de consentimiento ----
  {
    const rel = await relate(jorge);
    const { visit, fresh } = await openVisit(jorge, rel.id, `${DEMO_MARK}: visita de ejemplo (consentimiento faltante)`);
    if (fresh) {
      await diagnose(jorge, visit.id, 'Diagnóstico de demostración sin consentimiento clínico (dato ficticio)', 'PRESUMPTIVE');
      await procedure(jorge, visit.id, 'DEMO-RESTAURACION', 'Procedimiento de demostración pendiente de consentimiento (dato ficticio).', false);
      await note(jorge, visit.id, 'Evolución de demostración cerrada mientras el consentimiento está pendiente (dato ficticio).', null, 'closed');
    }
  }
  return { users, patients };
}
