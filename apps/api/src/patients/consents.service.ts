import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { CreateConsentDto, RevokeConsentDto } from './dto/consent.dto.js';
import { clinicScope, isUniqueViolation, requirePatient } from './patient-access.js';
import { isMinor } from './util/lima-date.js';

const CLOCK_SKEW_MS = 5 * 60_000;

@Injectable()
export class ConsentsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    const rows = await this.db.patientConsent.findMany({
      where: { patientId, clinicId },
      include: { attachments: { where: { status: 'ACTIVE' }, select: { id: true } } },
      orderBy: [{ grantedAt: 'desc' }, { createdAt: 'desc' }],
    });
    await this.audit.record({
      action: AuditAction.ConsentListed,
      entity: 'Patient',
      entityId: patientId,
      patientId,
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { count: rows.length },
    });
    return rows.map((c) => this.view(c));
  }

  async grant(actor: AuthPrincipal, patientId: string, dto: CreateConsentDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    const patient = await requirePatient(this.db, clinicId, patientId, { active: true });

    const grantedAt = dto.grantedAt ? new Date(dto.grantedAt) : new Date();
    if (Number.isNaN(grantedAt.getTime())) throw new BadRequestException('grantedAt no es una fecha válida');
    if (grantedAt.getTime() > Date.now() + CLOCK_SKEW_MS) {
      throw new BadRequestException('grantedAt no puede estar en el futuro');
    }

    // Un menor no otorga consentimiento por sí mismo: lo otorga un representante vigente.
    // (Edad de mayoría = 18; la capacidad de menores de 14-17 años: por validar.)
    const minor = isMinor(patient.birthDate, grantedAt);
    if (minor && dto.grantedBy !== 'GUARDIAN') {
      throw new BadRequestException('El paciente es menor de edad: el consentimiento debe otorgarlo un representante');
    }
    if (dto.grantedBy === 'GUARDIAN') {
      if (!dto.guardianId) throw new BadRequestException('guardianId es obligatorio cuando otorga un representante');
      const link = await this.db.patientGuardian.findFirst({
        where: { patientId, clinicId, guardianId: dto.guardianId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!link) throw new BadRequestException('El representante no está vinculado vigentemente a este paciente');
    } else if (dto.guardianId) {
      throw new BadRequestException('guardianId solo aplica cuando otorga un representante');
    }

    try {
      const id = await this.db.$transaction(async (tx) => {
        const row = await tx.patientConsent.create({
          data: {
            clinicId,
            patientId,
            type: dto.type,
            documentTitle: dto.documentTitle,
            documentVersion: dto.documentVersion,
            grantedAt,
            grantedBy: dto.grantedBy,
            guardianId: dto.guardianId ?? null,
            notes: dto.notes ?? null,
            activeKey: `${patientId}|${dto.type}`,
            createdById: actor.user.id,
          },
        });
        await this.audit.record(
          {
            action: AuditAction.ConsentGranted,
            entity: 'PatientConsent',
            entityId: row.id,
            patientId,
            userId: actor.user.id,
            clinicId,
            branchId,
            meta,
            summary: {
              type: dto.type,
              documentVersion: dto.documentVersion,
              grantedBy: dto.grantedBy,
              guardianId: dto.guardianId ?? null,
            },
          },
          tx,
        );
        return row.id;
      });
      return this.view(
        await this.db.patientConsent.findUniqueOrThrow({
          where: { id },
          include: { attachments: { where: { status: 'ACTIVE' }, select: { id: true } } },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Ya existe un consentimiento ${dto.type} vigente; revóquelo (con motivo) antes de registrar una nueva versión`,
        );
      }
      throw error;
    }
  }

  async revoke(actor: AuthPrincipal, patientId: string, consentId: string, dto: RevokeConsentDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    const consent = await this.db.patientConsent.findFirst({ where: { id: consentId, patientId, clinicId } });
    if (!consent) throw new NotFoundException('Consentimiento no encontrado');
    if (consent.status === 'REVOKED') throw new ConflictException('El consentimiento ya fue revocado');

    await this.db.$transaction(async (tx) => {
      await tx.patientConsent.update({
        where: { id: consentId },
        data: {
          status: 'REVOKED',
          activeKey: null,
          revokedAt: new Date(),
          revokedById: actor.user.id,
          revocationReason: dto.reason,
        },
      });
      await this.audit.record(
        {
          action: AuditAction.ConsentRevoked,
          entity: 'PatientConsent',
          entityId: consentId,
          patientId,
          userId: actor.user.id,
          clinicId,
          branchId,
          meta,
          summary: { type: consent.type, documentVersion: consent.documentVersion, reason: dto.reason },
        },
        tx,
      );
    });
    return this.view(
      await this.db.patientConsent.findUniqueOrThrow({
        where: { id: consentId },
        include: { attachments: { where: { status: 'ACTIVE' }, select: { id: true } } },
      }),
    );
  }

  private view(c: {
    id: string;
    type: string;
    status: string;
    documentTitle: string;
    documentVersion: string;
    grantedAt: Date;
    grantedBy: string;
    guardianId: string | null;
    notes: string | null;
    revokedAt: Date | null;
    revocationReason: string | null;
    createdAt: Date;
    attachments: { id: string }[];
  }) {
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      documentTitle: c.documentTitle,
      documentVersion: c.documentVersion,
      grantedAt: c.grantedAt,
      grantedBy: c.grantedBy,
      guardianId: c.guardianId,
      notes: c.notes,
      revokedAt: c.revokedAt,
      revocationReason: c.revocationReason,
      createdAt: c.createdAt,
      attachmentCount: c.attachments.length,
    };
  }
}
