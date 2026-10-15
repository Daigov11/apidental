import { clinicalConsentStatus, consentAlerts } from './consent-status.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type {
  ChangeContactDto,
  ContactInput,
  CreatePatientDto,
  DuplicateCheckDto,
  RetireContactDto,
  SearchPatientsQuery,
  SetIdentifierDto,
  UpdatePatientDto,
} from './dto/patient.dto.js';
import { DuplicatesService } from './duplicates.service.js';
import {
  canReadFull,
  clinicScope,
  isUniqueViolation,
  requirePatient,
} from './patient-access.js';
import {
  contactRow,
  identifierRow,
  parseBirthDate,
  type PreparedContact,
  prepareContacts,
  prepareIdentifier,
} from './patient-data.js';
import { type PatientRow, toBasicView, toFullView } from './patient-view.js';
import { isMinor } from './util/lima-date.js';
import { maskContact, maskTail } from './util/mask.js';
import {
  type ContactTypeCode,
  type IdentifierTypeCode,
  normalizeContact,
  normalizeIdentifier,
  normalizePhone,
} from './util/normalize.js';
import { normalizeEmail } from '../common/utils/email.js';

const ACTIVE_RELATIONS = {
  identifiers: {
    where: { status: 'ACTIVE' as const },
    orderBy: { type: 'asc' as const },
  },
  contacts: {
    where: { status: 'ACTIVE' as const },
    orderBy: [{ type: 'asc' as const }, { createdAt: 'asc' as const }],
  },
};

/** Contactos cuyo cambio exige motivo (dato de identificación y de comunicación). */
const REASON_REQUIRED: readonly ContactTypeCode[] = ['MOBILE', 'EMAIL'];

@Injectable()
export class PatientsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly duplicates: DuplicatesService,
  ) {}

  // ---------------------------------------------------------------- crear

  async create(actor: AuthPrincipal, dto: CreatePatientDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    const birthDate = parseBirthDate(dto.birthDate);
    const identifier = dto.identifier
      ? prepareIdentifier(dto.identifier)
      : null;
    const contacts = prepareContacts(dto.contacts ?? []);

    // 1) Identificador repetido en la clínica => conflicto, no se crea el duplicado.
    if (identifier)
      await this.duplicates.assertNoIdentifierConflict(
        this.db,
        clinicId,
        identifier,
      );

    // 2) Coincidencias blandas (nombre, nacimiento, celular, correo) => solo advertencia.
    const candidates = await this.duplicates.findCandidates(this.db, clinicId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      secondLastName: dto.secondLastName ?? null,
      birthDate,
      mobiles: contacts
        .filter((c) => c.type === 'MOBILE')
        .flatMap((c) => (c.valueKey ? [c.valueKey] : [])),
      emails: contacts
        .filter((c) => c.type === 'EMAIL')
        .flatMap((c) => (c.valueKey ? [c.valueKey] : [])),
    });

    let patientId: string;
    try {
      patientId = await this.db.$transaction(async (tx) => {
        const patient = await tx.patient.create({
          data: {
            clinicId,
            firstName: dto.firstName,
            lastName: dto.lastName,
            secondLastName: dto.secondLastName || null,
            birthDate,
            sex: dto.sex ?? null,
            createdBranchId: branchId,
            createdById: actor.user.id,
          },
        });
        if (identifier) {
          await tx.patientIdentifier.create({
            data: identifierRow(
              clinicId,
              patient.id,
              identifier,
              actor.user.id,
            ),
          });
        }
        for (const c of contacts) {
          await tx.patientContact.create({
            data: contactRow(clinicId, patient.id, c, actor.user.id),
          });
        }
        await this.audit.record(
          {
            action: AuditAction.PatientCreated,
            entity: 'Patient',
            entityId: patient.id,
            patientId: patient.id,
            userId: actor.user.id,
            clinicId,
            branchId,
            meta,
            summary: {
              identifierType: identifier?.type ?? null,
              contactTypes: contacts.map((c) => c.type),
              duplicateCandidates: candidates.length,
              minor: isMinor(birthDate),
            },
          },
          tx,
        );
        return patient.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Conflicto de unicidad al crear el paciente (identificador ya registrado)',
        );
      }
      throw error;
    }

    return {
      patient: await this.loadView(actor, clinicId, patientId),
      duplicateWarnings: this.duplicates.present(candidates, actor),
      // Un paciente nuevo no tiene consentimiento clínico: se avisa, pero no impide registrarlo ni agendarlo.
      warnings: [...(isMinor(birthDate) ? ['MINOR_WITHOUT_GUARDIAN'] : []), 'CLINICAL_CONSENT_MISSING'],
    };
  }

  // ------------------------------------------------------------- consultar

  async search(
    actor: AuthPrincipal,
    q: SearchPatientsQuery,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    const and: Record<string, unknown>[] = [];
    const used: string[] = [];

    if (q.identifier) {
      used.push('identifier');
      const number = q.identifierType
        ? normalizeIdentifier(
            q.identifierType as IdentifierTypeCode,
            q.identifier,
          )
        : q.identifier.replace(/[\s-]/g, '').toUpperCase();
      and.push({
        identifiers: {
          some: {
            status: 'ACTIVE',
            number,
            ...(q.identifierType ? { type: q.identifierType } : {}),
          },
        },
      });
    }
    if (q.name) {
      used.push('name');
      for (const token of q.name.split(/\s+/).filter(Boolean).slice(0, 5)) {
        and.push({
          OR: [
            { firstName: { contains: token } },
            { lastName: { contains: token } },
            { secondLastName: { contains: token } },
          ],
        });
      }
    }
    if (q.phone) {
      used.push('phone');
      and.push({
        contacts: {
          some: {
            status: 'ACTIVE',
            type: { in: ['MOBILE', 'PHONE'] },
            valueKey: normalizePhone(q.phone),
          },
        },
      });
    }
    if (q.email) {
      used.push('email');
      and.push({
        contacts: {
          some: {
            status: 'ACTIVE',
            type: 'EMAIL',
            valueKey: normalizeEmail(q.email),
          },
        },
      });
    }
    if (q.birthDate) {
      used.push('birthDate');
      and.push({ birthDate: parseBirthDate(q.birthDate) });
    }

    const rows = await this.db.patient.findMany({
      where: { clinicId, status: q.status ?? 'ACTIVE', AND: and },
      include: ACTIVE_RELATIONS,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: q.limit,
      skip: q.offset,
    });

    // Una búsqueda expone datos personales: se audita sin guardar los valores buscados.
    await this.audit.record({
      action: AuditAction.PatientSearched,
      entity: 'Patient',
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { filters: used, resultCount: rows.length, offset: q.offset },
    });
    return rows.map((r) =>
      canReadFull(actor)
        ? toFullView(r as PatientRow)
        : toBasicView(r as PatientRow),
    );
  }

  async get(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    const row = await this.db.patient.findFirst({
      where: { id: patientId, clinicId },
      include: ACTIVE_RELATIONS,
    });
    if (!row) throw new NotFoundException('Paciente no encontrado');

    const full = canReadFull(actor);
    const guardians = full
      ? await this.db.patientGuardian.findMany({
          where: { patientId, clinicId, status: 'ACTIVE' },
          include: { guardian: true },
        })
      : [];

    await this.audit.record({
      action: AuditAction.PatientViewed,
      entity: 'Patient',
      entityId: patientId,
      patientId,
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: {
        sections: full ? ['demographics', 'contacts', 'guardians'] : ['basic'],
      },
    });

    if (!full) return toBasicView(row as PatientRow);
    const minor = isMinor(row.birthDate);
    // Alerta (no bloqueo): sin consentimiento clínico vigente se avisa, pero se puede seguir atendiendo lo administrativo.
    const consentWarnings = consentAlerts(
      await clinicalConsentStatus(this.db, clinicId, patientId),
    ).map((a) => a.code);
    return {
      ...toFullView(row as PatientRow),
      guardianCount: guardians.length,
      warnings: [
        ...(minor && guardians.length === 0 ? ['MINOR_WITHOUT_GUARDIAN'] : []),
        ...consentWarnings,
      ],
    };
  }

  // ------------------------------------------------------------- modificar

  async update(
    actor: AuthPrincipal,
    patientId: string,
    dto: UpdatePatientDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    const current = await requirePatient(this.db, clinicId, patientId, {
      active: true,
    });

    const data: Record<string, unknown> = {};
    const changed: string[] = [];
    const set = (field: string, next: unknown, prev: unknown) => {
      const same =
        next instanceof Date && prev instanceof Date
          ? next.getTime() === prev.getTime()
          : next === prev;
      if (!same) {
        data[field] = next;
        changed.push(field);
      }
    };
    if (dto.firstName !== undefined)
      set('firstName', dto.firstName, current.firstName);
    if (dto.lastName !== undefined)
      set('lastName', dto.lastName, current.lastName);
    if (dto.secondLastName !== undefined)
      set('secondLastName', dto.secondLastName || null, current.secondLastName);
    if (dto.sex !== undefined) set('sex', dto.sex, current.sex);
    if (dto.birthDate !== undefined)
      set('birthDate', parseBirthDate(dto.birthDate), current.birthDate);

    if (changed.length === 0) {
      return {
        patient: await this.loadView(actor, clinicId, patientId),
        duplicateWarnings: [],
      };
    }

    await this.db.$transaction(async (tx) => {
      await tx.patient.update({
        where: { id: patientId },
        data: { ...data, updatedById: actor.user.id },
      });
      await this.audit.record(
        {
          action: AuditAction.PatientUpdated,
          entity: 'Patient',
          entityId: patientId,
          patientId,
          userId: actor.user.id,
          clinicId,
          branchId,
          meta,
          // Solo nombres de campos: los valores de nombre/nacimiento no se copian a la auditoría inmutable.
          summary: { changedFields: changed, reason: dto.reason ?? null },
        },
        tx,
      );
    });

    const identityChanged = changed.some((f) =>
      ['firstName', 'lastName', 'secondLastName', 'birthDate'].includes(f),
    );
    let duplicateWarnings: unknown[] = [];
    if (identityChanged) {
      const updated = await requirePatient(this.db, clinicId, patientId);
      const found = await this.duplicates.findCandidates(
        this.db,
        clinicId,
        {
          firstName: updated.firstName,
          lastName: updated.lastName,
          secondLastName: updated.secondLastName,
          birthDate: updated.birthDate,
        },
        patientId,
      );
      duplicateWarnings = this.duplicates.present(found, actor);
    }
    return {
      patient: await this.loadView(actor, clinicId, patientId),
      duplicateWarnings,
    };
  }

  /** Baja/alta lógica del paciente (nunca se elimina físicamente). */
  async setStatus(
    actor: AuthPrincipal,
    patientId: string,
    status: 'ACTIVE' | 'INACTIVE',
    reason: string,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    const current = await requirePatient(this.db, clinicId, patientId);
    if (current.status === status) {
      throw new ConflictException(
        status === 'INACTIVE'
          ? 'El paciente ya está inactivo'
          : 'El paciente ya está activo',
      );
    }
    await this.db.$transaction(async (tx) => {
      await tx.patient.update({
        where: { id: patientId },
        data: { status, statusReason: reason, updatedById: actor.user.id },
      });
      await this.audit.record(
        {
          action:
            status === 'INACTIVE'
              ? AuditAction.PatientDeactivated
              : AuditAction.PatientReactivated,
          entity: 'Patient',
          entityId: patientId,
          patientId,
          userId: actor.user.id,
          clinicId,
          branchId,
          meta,
          summary: { reason },
        },
        tx,
      );
    });
    return { patient: await this.loadView(actor, clinicId, patientId) };
  }

  // ---------------------------------------------------------- identificadores

  /** Alta o reemplazo del identificador vigente de un tipo. El anterior se conserva como historial. */
  async setIdentifier(
    actor: AuthPrincipal,
    patientId: string,
    dto: SetIdentifierDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });
    const next = prepareIdentifier(dto);

    const current = await this.db.patientIdentifier.findFirst({
      where: { patientId, clinicId, type: next.type, status: 'ACTIVE' },
    });
    if (current?.number === next.number) {
      return {
        identifiers: await this.activeIdentifiers(clinicId, patientId),
        changed: false,
      };
    }
    if (current && !dto.reason) {
      throw new BadRequestException(
        'Reemplazar un identificador requiere un motivo',
      );
    }
    await this.duplicates.assertNoIdentifierConflict(
      this.db,
      clinicId,
      next,
      patientId,
    );

    try {
      await this.db.$transaction(async (tx) => {
        if (current) {
          await tx.patientIdentifier.update({
            where: { id: current.id },
            data: {
              status: 'SUPERSEDED',
              activeKey: null,
              patientTypeKey: null,
              supersededAt: new Date(),
              changeReason: dto.reason,
            },
          });
        }
        await tx.patientIdentifier.create({
          data: {
            ...identifierRow(clinicId, patientId, next, actor.user.id),
            changeReason: dto.reason ?? null,
          },
        });
        await this.audit.record(
          {
            action: AuditAction.IdentifierChanged,
            entity: 'PatientIdentifier',
            entityId: patientId,
            patientId,
            userId: actor.user.id,
            clinicId,
            branchId,
            meta,
            summary: {
              type: next.type,
              operation: current ? 'REPLACED' : 'ADDED',
              previous: current ? maskTail(current.number) : null,
              new: maskTail(next.number),
              reason: dto.reason ?? null,
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Ese identificador ya está registrado en la clínica',
        );
      throw error;
    }
    return {
      identifiers: await this.activeIdentifiers(clinicId, patientId),
      changed: true,
    };
  }

  private async activeIdentifiers(clinicId: string, patientId: string) {
    const rows = await this.db.patientIdentifier.findMany({
      where: { clinicId, patientId, status: 'ACTIVE' },
      orderBy: { type: 'asc' },
    });
    return rows.map((r) => ({ type: r.type, number: r.number }));
  }

  // ---------------------------------------------------------------- contactos

  async addContact(
    actor: AuthPrincipal,
    patientId: string,
    dto: ContactInput,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });
    const type = dto.type as ContactTypeCode;
    const normalized = normalizeContact(type, dto.value);

    const existing = await this.db.patientContact.findMany({
      where: { clinicId, patientId, type, status: 'ACTIVE' },
      select: { valueKey: true, isPrimary: true },
    });
    if (
      normalized.valueKey &&
      existing.some((c) => c.valueKey === normalized.valueKey)
    ) {
      throw new ConflictException('El paciente ya tiene ese contacto vigente');
    }
    const hasPrimary = existing.some((c) => c.isPrimary);
    if (dto.isPrimary && hasPrimary) {
      throw new ConflictException(
        'Ya existe un contacto principal de ese tipo; use PATCH para reemplazarlo con un motivo',
      );
    }
    const prepared: PreparedContact = {
      type,
      ...normalized,
      label: dto.label ?? null,
      isPrimary: dto.isPrimary ?? !hasPrimary,
    };

    let contactId = '';
    try {
      await this.db.$transaction(async (tx) => {
        const row = await tx.patientContact.create({
          data: contactRow(clinicId, patientId, prepared, actor.user.id),
        });
        contactId = row.id;
        await this.audit.record(
          {
            action: AuditAction.ContactAdded,
            entity: 'PatientContact',
            entityId: row.id,
            patientId,
            userId: actor.user.id,
            clinicId,
            branchId,
            meta,
            summary: {
              type,
              value: maskContact(type, prepared.value),
              isPrimary: prepared.isPrimary,
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Contacto duplicado o principal ya existente',
        );
      throw error;
    }
    return {
      contact: await this.contactView(contactId),
      duplicateWarnings: await this.contactWarnings(
        actor,
        clinicId,
        patientId,
        prepared,
      ),
    };
  }

  /** Reemplaza el valor de un contacto: el anterior queda como historial. */
  async changeContact(
    actor: AuthPrincipal,
    patientId: string,
    contactId: string,
    dto: ChangeContactDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });
    const current = await this.activeContact(clinicId, patientId, contactId);
    const type = current.type as ContactTypeCode;
    if (REASON_REQUIRED.includes(type) && !dto.reason) {
      throw new BadRequestException(
        'Cambiar un celular o correo requiere un motivo',
      );
    }
    const next = normalizeContact(type, dto.value);
    if (next.valueKey === current.valueKey && next.value === current.value) {
      return {
        contact: await this.contactView(current.id),
        duplicateWarnings: [],
      };
    }
    const prepared: PreparedContact = {
      type,
      ...next,
      label: current.label,
      isPrimary: current.isPrimary,
    };

    let newId = '';
    try {
      await this.db.$transaction(async (tx) => {
        await tx.patientContact.update({
          where: { id: current.id },
          data: {
            status: 'SUPERSEDED',
            primaryKey: null,
            activeKey: null,
            supersededAt: new Date(),
            changeReason: dto.reason ?? null,
          },
        });
        const row = await tx.patientContact.create({
          data: {
            ...contactRow(clinicId, patientId, prepared, actor.user.id),
            changeReason: dto.reason ?? null,
          },
        });
        newId = row.id;
        await this.audit.record(
          {
            action: AuditAction.ContactChanged,
            entity: 'PatientContact',
            entityId: row.id,
            patientId,
            userId: actor.user.id,
            clinicId,
            branchId,
            meta,
            summary: {
              type,
              previous: maskContact(type, current.value),
              new: maskContact(type, prepared.value),
              reason: dto.reason ?? null,
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'El paciente ya tiene ese contacto vigente',
        );
      throw error;
    }
    return {
      contact: await this.contactView(newId),
      duplicateWarnings: await this.contactWarnings(
        actor,
        clinicId,
        patientId,
        prepared,
      ),
    };
  }

  async retireContact(
    actor: AuthPrincipal,
    patientId: string,
    contactId: string,
    dto: RetireContactDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });
    const current = await this.activeContact(clinicId, patientId, contactId);
    const type = current.type as ContactTypeCode;
    if (REASON_REQUIRED.includes(type) && !dto.reason) {
      throw new BadRequestException(
        'Dar de baja un celular o correo requiere un motivo',
      );
    }
    await this.db.$transaction(async (tx) => {
      await tx.patientContact.update({
        where: { id: current.id },
        data: {
          status: 'SUPERSEDED',
          primaryKey: null,
          activeKey: null,
          supersededAt: new Date(),
          changeReason: dto.reason ?? null,
        },
      });
      await this.audit.record(
        {
          action: AuditAction.ContactRetired,
          entity: 'PatientContact',
          entityId: current.id,
          patientId,
          userId: actor.user.id,
          clinicId,
          branchId,
          meta,
          summary: {
            type,
            previous: maskContact(type, current.value),
            reason: dto.reason ?? null,
          },
        },
        tx,
      );
    });
    return { retired: true };
  }

  private async activeContact(
    clinicId: string,
    patientId: string,
    contactId: string,
  ) {
    const contact = await this.db.patientContact.findFirst({
      where: { id: contactId, patientId, clinicId, status: 'ACTIVE' },
    });
    if (!contact) throw new NotFoundException('Contacto no encontrado');
    return contact;
  }

  private async contactView(id: string) {
    const c = await this.db.patientContact.findUniqueOrThrow({ where: { id } });
    return {
      id: c.id,
      type: c.type,
      value: c.value,
      label: c.label,
      isPrimary: c.isPrimary,
    };
  }

  private async contactWarnings(
    actor: AuthPrincipal,
    clinicId: string,
    patientId: string,
    c: PreparedContact,
  ) {
    if (!c.valueKey || (c.type !== 'MOBILE' && c.type !== 'EMAIL')) return [];
    const found = await this.duplicates.findCandidates(
      this.db,
      clinicId,
      c.type === 'MOBILE'
        ? { mobiles: [c.valueKey] }
        : { emails: [c.valueKey] },
      patientId,
    );
    return this.duplicates.present(found, actor);
  }

  // --------------------------------------------------------------- duplicados

  /** Verificación previa al alta (o al editar): no escribe nada. */
  async checkDuplicates(
    actor: AuthPrincipal,
    dto: DuplicateCheckDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    const identifier = dto.identifier
      ? prepareIdentifier(dto.identifier)
      : null;
    const conflict = identifier
      ? await this.duplicates.findIdentifierConflict(
          this.db,
          clinicId,
          identifier,
        )
      : null;
    const found = await this.duplicates.findCandidates(this.db, clinicId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      secondLastName: dto.secondLastName ?? null,
      birthDate: parseBirthDate(dto.birthDate),
      mobiles: dto.mobile ? [normalizePhone(dto.mobile)] : [],
      emails: dto.email ? [normalizeEmail(dto.email)] : [],
    });
    await this.audit.record({
      action: AuditAction.DuplicatesViewed,
      entity: 'Patient',
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: {
        mode: 'check',
        identifierConflict: Boolean(conflict),
        candidates: found.length,
      },
    });
    return {
      identifierConflict: conflict,
      possibleDuplicates: this.duplicates.present(found, actor),
    };
  }

  async duplicatesOf(
    actor: AuthPrincipal,
    patientId: string,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    const p = await this.db.patient.findFirst({
      where: { id: patientId, clinicId },
      include: { contacts: { where: { status: 'ACTIVE' } } },
    });
    if (!p) throw new NotFoundException('Paciente no encontrado');
    const found = await this.duplicates.findCandidates(
      this.db,
      clinicId,
      {
        firstName: p.firstName,
        lastName: p.lastName,
        secondLastName: p.secondLastName,
        birthDate: p.birthDate,
        mobiles: p.contacts
          .filter((c) => c.type === 'MOBILE' && c.valueKey)
          .map((c) => c.valueKey!),
        emails: p.contacts
          .filter((c) => c.type === 'EMAIL' && c.valueKey)
          .map((c) => c.valueKey!),
      },
      patientId,
    );
    await this.audit.record({
      action: AuditAction.DuplicatesViewed,
      entity: 'Patient',
      entityId: patientId,
      patientId,
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { mode: 'patient', candidates: found.length },
    });
    return {
      patientId,
      possibleDuplicates: this.duplicates.present(found, actor),
    };
  }

  async duplicateReport(actor: AuthPrincipal, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    const groups = await this.duplicates.report(clinicId);
    await this.audit.record({
      action: AuditAction.DuplicateReportViewed,
      entity: 'Patient',
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { groups: groups.length },
    });
    return { generatedAt: new Date().toISOString(), groups };
  }

  // ------------------------------------------------------------------ internos

  private async loadView(
    actor: AuthPrincipal,
    clinicId: string,
    patientId: string,
  ) {
    const row = await this.db.patient.findFirstOrThrow({
      where: { id: patientId, clinicId },
      include: ACTIVE_RELATIONS,
    });
    return canReadFull(actor)
      ? toFullView(row as PatientRow)
      : toBasicView(row as PatientRow);
  }
}
