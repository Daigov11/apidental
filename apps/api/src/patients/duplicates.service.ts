import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { canReadFull } from './patient-access.js';
import { formatDateOnly } from './util/lima-date.js';
import { fullName } from './patient-view.js';
import type { IdentifierTypeCode } from './util/normalize.js';

export type DuplicateReason = 'NAME_AND_BIRTHDATE' | 'NAME' | 'MOBILE' | 'EMAIL';
export type DuplicateConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DuplicateCandidateInput {
  firstName?: string;
  lastName?: string;
  secondLastName?: string | null;
  birthDate?: Date | null;
  /** Celulares/correos ya normalizados. */
  mobiles?: string[];
  emails?: string[];
}

export interface DuplicateMatch {
  patientId: string;
  fullName: string;
  birthDate: string | null;
  status: string;
  reasons: DuplicateReason[];
  confidence: DuplicateConfidence;
}

const MAX_MATCHES = 10;

/**
 * Detección de posibles duplicados. NUNCA fusiona ni bloquea por sí sola:
 *  - Identificador (DNI/CE/pasaporte) vigente repetido en la clínica => conflicto (409).
 *  - Nombre, fecha de nacimiento, celular o correo => solo advertencia.
 * La comparación de textos aprovecha la colación utf8mb4_unicode_ci (sin distinguir
 * mayúsculas ni tildes: "José" = "jose").
 */
@Injectable()
export class DuplicatesService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  async findIdentifierConflict(
    db: DbTx | PrismaDb,
    clinicId: string,
    identifier: { type: IdentifierTypeCode; number: string },
    excludePatientId?: string,
  ) {
    const found = await db.patientIdentifier.findFirst({
      where: {
        clinicId,
        type: identifier.type,
        number: identifier.number,
        status: 'ACTIVE',
        ...(excludePatientId ? { patientId: { not: excludePatientId } } : {}),
      },
      include: { patient: { select: { id: true, firstName: true, lastName: true, secondLastName: true } } },
    });
    return found ? { id: found.patient.id, fullName: fullName(found.patient) } : null;
  }

  async assertNoIdentifierConflict(
    db: DbTx | PrismaDb,
    clinicId: string,
    identifier: { type: IdentifierTypeCode; number: string },
    excludePatientId?: string,
  ): Promise<void> {
    const existing = await this.findIdentifierConflict(db, clinicId, identifier, excludePatientId);
    if (existing) {
      throw new ConflictException({
        message: `Ya existe un paciente con ese ${identifier.type} en la clínica`,
        code: 'IDENTIFIER_CONFLICT',
        existingPatient: existing,
      });
    }
  }

  async findCandidates(
    db: DbTx | PrismaDb,
    clinicId: string,
    input: DuplicateCandidateInput,
    excludePatientId?: string,
  ): Promise<DuplicateMatch[]> {
    const reasons = new Map<string, Set<DuplicateReason>>();
    const add = (id: string, reason: DuplicateReason) => {
      if (id === excludePatientId) return;
      (reasons.get(id) ?? reasons.set(id, new Set()).get(id)!).add(reason);
    };

    if (input.firstName && input.lastName) {
      const byName = await db.patient.findMany({
        where: {
          clinicId,
          firstName: input.firstName,
          lastName: input.lastName,
          ...(input.secondLastName ? { OR: [{ secondLastName: input.secondLastName }, { secondLastName: null }] } : {}),
        },
        select: { id: true, birthDate: true },
        take: 50,
      });
      for (const p of byName) {
        const sameBirth = input.birthDate && p.birthDate && p.birthDate.getTime() === input.birthDate.getTime();
        add(p.id, sameBirth ? 'NAME_AND_BIRTHDATE' : 'NAME');
      }
    }

    const keys = [
      ...(input.mobiles ?? []).map((v) => ({ type: 'MOBILE' as const, v })),
      ...(input.emails ?? []).map((v) => ({ type: 'EMAIL' as const, v })),
    ];
    for (const { type, v } of keys) {
      const contacts = await db.patientContact.findMany({
        where: { clinicId, type, valueKey: v, status: 'ACTIVE' },
        select: { patientId: true },
        take: 50,
      });
      for (const c of contacts) add(c.patientId, type);
    }

    if (reasons.size === 0) return [];
    const patients = await db.patient.findMany({
      where: { clinicId, id: { in: [...reasons.keys()] } },
      select: { id: true, firstName: true, lastName: true, secondLastName: true, birthDate: true, status: true },
    });
    return patients
      .map((p) => {
        const r = [...(reasons.get(p.id) ?? [])];
        return {
          patientId: p.id,
          fullName: fullName(p),
          birthDate: formatDateOnly(p.birthDate),
          status: p.status,
          reasons: r,
          confidence: confidenceOf(r),
        };
      })
      .sort((a, b) => rank(b.confidence) - rank(a.confidence))
      .slice(0, MAX_MATCHES);
  }

  /** Oculta la fecha de nacimiento a quien solo tiene lectura mínima. */
  present(matches: DuplicateMatch[], actor: AuthPrincipal) {
    const full = canReadFull(actor);
    return matches.map((m) => ({ ...m, birthDate: full ? m.birthDate : null }));
  }

  /** Reporte por clínica: grupos de pacientes que comparten nombre+nacimiento, celular o correo. */
  async report(clinicId: string, limit = 50) {
    const nameGroups = await this.db.patient.groupBy({
      by: ['firstName', 'lastName', 'birthDate'],
      where: { clinicId, birthDate: { not: null } },
      _count: { _all: true },
      having: { id: { _count: { gt: 1 } } },
      orderBy: { lastName: 'asc' },
      take: limit,
    });
    const contactGroups = await this.db.patientContact.groupBy({
      by: ['type', 'valueKey'],
      where: { clinicId, status: 'ACTIVE', type: { in: ['MOBILE', 'EMAIL'] }, valueKey: { not: null } },
      having: { patientId: { _count: { gt: 1 } } },
      orderBy: { valueKey: 'asc' },
      take: limit,
    });

    const groups: { reason: DuplicateReason; confidence: DuplicateConfidence; patientIds: string[] }[] = [];
    for (const g of nameGroups) {
      const rows = await this.db.patient.findMany({
        where: { clinicId, firstName: g.firstName, lastName: g.lastName, birthDate: g.birthDate },
        select: { id: true },
      });
      groups.push({ reason: 'NAME_AND_BIRTHDATE', confidence: 'HIGH', patientIds: rows.map((r) => r.id) });
    }
    for (const g of contactGroups) {
      const rows = await this.db.patientContact.findMany({
        where: { clinicId, type: g.type, valueKey: g.valueKey, status: 'ACTIVE' },
        select: { patientId: true },
        distinct: ['patientId'],
      });
      groups.push({
        reason: g.type === 'MOBILE' ? 'MOBILE' : 'EMAIL',
        // Un celular compartido es normal entre familiares: confianza baja.
        confidence: g.type === 'MOBILE' ? 'LOW' : 'MEDIUM',
        patientIds: rows.map((r) => r.patientId),
      });
    }

    const ids = [...new Set(groups.flatMap((g) => g.patientIds))];
    const patients = await this.db.patient.findMany({
      where: { clinicId, id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, secondLastName: true, birthDate: true, status: true },
    });
    const byId = new Map(patients.map((p) => [p.id, p]));
    return groups
      .filter((g) => g.patientIds.length > 1)
      .map((g) => ({
        reason: g.reason,
        confidence: g.confidence,
        patients: g.patientIds.flatMap((id) => {
          const p = byId.get(id);
          return p ? [{ patientId: p.id, fullName: fullName(p), birthDate: formatDateOnly(p.birthDate), status: p.status }] : [];
        }),
      }));
  }
}

function confidenceOf(reasons: DuplicateReason[]): DuplicateConfidence {
  if (reasons.includes('NAME_AND_BIRTHDATE')) return 'HIGH';
  const hasName = reasons.includes('NAME');
  const hasContact = reasons.includes('EMAIL') || reasons.includes('MOBILE');
  if (hasName && hasContact) return 'MEDIUM';
  if (reasons.includes('EMAIL')) return 'MEDIUM';
  return 'LOW';
}

const rank = (c: DuplicateConfidence): number => ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[c];
