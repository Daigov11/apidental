import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { normalizeEmail } from '../common/utils/email.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { EndGuardianLinkDto, GuardianInput, LinkGuardianDto } from './dto/guardian.dto.js';
import { clinicScope, isUniqueViolation, requirePatient } from './patient-access.js';
import { fullName } from './patient-view.js';
import { maskTail } from './util/mask.js';
import { type IdentifierTypeCode, normalizeIdentifier, normalizePhone } from './util/normalize.js';

const guardianView = (g: {
  id: string;
  firstName: string;
  lastName: string;
  secondLastName: string | null;
  identifierType: string | null;
  identifierNumber: string | null;
  mobile: string | null;
  email: string | null;
}) => ({
  id: g.id,
  fullName: fullName(g),
  firstName: g.firstName,
  lastName: g.lastName,
  secondLastName: g.secondLastName,
  identifierType: g.identifierType,
  identifierNumber: g.identifierNumber,
  mobile: g.mobile,
  email: g.email,
});

@Injectable()
export class GuardiansService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  async listForPatient(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    const links = await this.db.patientGuardian.findMany({
      where: { patientId, clinicId },
      include: { guardian: true },
      orderBy: { createdAt: 'asc' },
    });
    await this.audit.record({
      action: AuditAction.GuardiansViewed,
      entity: 'Patient',
      entityId: patientId,
      patientId,
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { count: links.length },
    });
    return links.map((l) => this.linkView(l));
  }

  /** Búsqueda de apoderados existentes de la clínica para reutilizarlos (hermanos). */
  async search(actor: AuthPrincipal, search: string, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    const tokens = search.split(/\s+/).filter(Boolean).slice(0, 4);
    const rows = await this.db.guardian.findMany({
      where: {
        clinicId,
        AND: tokens.map((t) => ({
          OR: [
            { firstName: { contains: t } },
            { lastName: { contains: t } },
            { secondLastName: { contains: t } },
            { identifierNumber: { equals: t.toUpperCase() } },
          ],
        })),
      },
      orderBy: { lastName: 'asc' },
      take: 20,
    });
    await this.audit.record({
      action: AuditAction.GuardiansViewed,
      entity: 'Guardian',
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { mode: 'search', resultCount: rows.length },
    });
    return rows.map((g) => ({
      id: g.id,
      fullName: fullName(g),
      identifierType: g.identifierType,
      identifierNumber: g.identifierNumber ? maskTail(g.identifierNumber) : null,
    }));
  }

  async link(actor: AuthPrincipal, patientId: string, dto: LinkGuardianDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });
    if (Boolean(dto.guardianId) === Boolean(dto.guardian)) {
      throw new BadRequestException('Indique guardianId (existente) o guardian (nuevo), pero no ambos');
    }

    const activeLinks = await this.db.patientGuardian.findMany({
      where: { patientId, clinicId, status: 'ACTIVE' },
      select: { guardianId: true, isPrimary: true },
    });
    const hasPrimary = activeLinks.some((l) => l.isPrimary);
    if (dto.isPrimary && hasPrimary) throw new ConflictException('El paciente ya tiene un representante principal');

    let newGuardian: ReturnType<typeof prepareGuardian> | null = null;
    if (dto.guardian) {
      newGuardian = prepareGuardian(dto.guardian);
      if (newGuardian.identifierType && newGuardian.identifierNumber) {
        const existing = await this.db.guardian.findFirst({
          where: { clinicId, identifierType: newGuardian.identifierType, identifierNumber: newGuardian.identifierNumber },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException({
            message: 'Ya existe un representante con ese documento en la clínica; reutilícelo con guardianId',
            code: 'GUARDIAN_EXISTS',
            existingGuardianId: existing.id,
          });
        }
      }
    } else {
      const found = await this.db.guardian.findFirst({ where: { id: dto.guardianId, clinicId }, select: { id: true } });
      if (!found) throw new NotFoundException('Representante no encontrado');
      if (activeLinks.some((l) => l.guardianId === dto.guardianId)) {
        throw new ConflictException('Ese representante ya está vinculado al paciente');
      }
    }

    try {
      const linkId = await this.db.$transaction(async (tx) => {
        const guardianId = newGuardian
          ? (await tx.guardian.create({ data: { clinicId, ...newGuardian, createdById: actor.user.id } })).id
          : dto.guardianId!;
        const link = await tx.patientGuardian.create({
          data: {
            clinicId,
            patientId,
            guardianId,
            relationship: dto.relationship,
            isPrimary: dto.isPrimary ?? !hasPrimary,
            isLegalRepresentative: dto.isLegalRepresentative ?? false,
            activeKey: `${patientId}|${guardianId}`,
            createdById: actor.user.id,
          },
        });
        await this.audit.record(
          {
            action: AuditAction.GuardianLinked,
            entity: 'PatientGuardian',
            entityId: link.id,
            patientId,
            userId: actor.user.id,
            clinicId,
            branchId,
            meta,
            summary: { guardianId, relationship: dto.relationship, created: Boolean(newGuardian) },
          },
          tx,
        );
        return link.id;
      });
      const created = await this.db.patientGuardian.findUniqueOrThrow({ where: { id: linkId }, include: { guardian: true } });
      return this.linkView(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('El vínculo ya existe');
      throw error;
    }
  }

  async endLink(actor: AuthPrincipal, patientId: string, linkId: string, dto: EndGuardianLinkDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });
    const link = await this.db.patientGuardian.findFirst({ where: { id: linkId, patientId, clinicId } });
    if (!link) throw new NotFoundException('Vínculo no encontrado');
    if (link.status === 'ENDED') throw new ConflictException('El vínculo ya está finalizado');

    await this.db.$transaction(async (tx) => {
      await tx.patientGuardian.update({
        where: { id: linkId },
        data: { status: 'ENDED', activeKey: null, endedAt: new Date(), endReason: dto.reason },
      });
      await this.audit.record(
        {
          action: AuditAction.GuardianUnlinked,
          entity: 'PatientGuardian',
          entityId: linkId,
          patientId,
          userId: actor.user.id,
          clinicId,
          branchId,
          meta,
          summary: { guardianId: link.guardianId, reason: dto.reason },
        },
        tx,
      );
    });
    return { ended: true };
  }

  private linkView(l: {
    id: string;
    relationship: string;
    isPrimary: boolean;
    isLegalRepresentative: boolean;
    status: string;
    createdAt: Date;
    endedAt: Date | null;
    guardian: Parameters<typeof guardianView>[0];
  }) {
    return {
      id: l.id,
      relationship: l.relationship,
      isPrimary: l.isPrimary,
      isLegalRepresentative: l.isLegalRepresentative,
      status: l.status,
      createdAt: l.createdAt,
      endedAt: l.endedAt,
      guardian: guardianView(l.guardian),
    };
  }
}

function prepareGuardian(input: GuardianInput) {
  let identifierType: IdentifierTypeCode | null = null;
  let identifierNumber: string | null = null;
  if (input.identifierType || input.identifierNumber) {
    if (!input.identifierType || !input.identifierNumber) {
      throw new BadRequestException('Indique identifierType e identifierNumber juntos');
    }
    identifierType = input.identifierType as IdentifierTypeCode;
    identifierNumber = normalizeIdentifier(identifierType, input.identifierNumber);
  }
  const email = input.email ? normalizeEmail(input.email) : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('Correo del representante inválido');
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    secondLastName: input.secondLastName || null,
    identifierType,
    identifierNumber,
    mobile: input.mobile ? normalizePhone(input.mobile) : null,
    email,
  };
}
