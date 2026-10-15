import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { versionConflict } from './clinical-versioning.js';
import type {
  CreateProcedureDefinitionDto,
  ListDefinitionsQuery,
  UpdateProcedureDefinitionDto,
} from './dto/care.dto.js';

const present = (d: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  requiresClinicalConsent: boolean;
  status: string;
  version: number;
  updatedAt: Date;
}) => ({
  id: d.id,
  code: d.code,
  name: d.name,
  description: d.description,
  requiresClinicalConsent: d.requiresClinicalConsent,
  status: d.status,
  version: d.version,
  updatedAt: d.updatedAt,
  administrativeAidOnly: true,
});

/**
 * Catálogo de procedimientos CONFIGURABLE por clínica. No es un nomenclador ni una guía clínica: cada clínica define
 * los suyos y si cerrar uno exige consentimiento clínico vigente. Es configuración administrativa (no datos de
 * pacientes); cada cambio queda auditado (versión, campos y el valor del indicador de consentimiento, que es política
 * de la clínica). Nunca se borra: se desactiva.
 */
@Injectable()
export class ProcedureDefinitionsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  private clinicOf(actor: AuthPrincipal): {
    clinicId: string;
    branchId: string | null;
  } {
    const ctx = actor.context;
    if (!ctx || ctx.clinicId === null)
      throw new ForbiddenException(
        'El catálogo se configura dentro de una clínica',
      );
    return { clinicId: ctx.clinicId, branchId: ctx.branchId };
  }

  async list(actor: AuthPrincipal, q: ListDefinitionsQuery) {
    const { clinicId } = this.clinicOf(actor);
    const rows = await this.db.procedureDefinition.findMany({
      where: { clinicId, ...(q.status ? { status: q.status } : {}) },
      orderBy: [{ code: 'asc' }],
      take: q.limit,
      skip: q.offset,
    });
    return rows.map(present);
  }

  async create(
    actor: AuthPrincipal,
    dto: CreateProcedureDefinitionDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = this.clinicOf(actor);
    try {
      const row = await this.db.$transaction(async (tx) => {
        const created = await tx.procedureDefinition.create({
          data: {
            clinicId,
            code: dto.code,
            name: dto.name,
            description: dto.description || null,
            requiresClinicalConsent: dto.requiresClinicalConsent ?? false,
            createdById: actor.user.id,
          },
        });
        await this.record(
          tx,
          actor,
          clinicId,
          branchId,
          meta,
          'CREATED',
          created.id,
          created.version,
          ['code', 'name', 'description', 'requiresClinicalConsent'],
          created.requiresClinicalConsent,
        );
        return created;
      });
      return present(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException({
          message: 'Ya existe un procedimiento con ese código en la clínica',
          code: 'CODE_EXISTS',
        });
      throw error;
    }
  }

  async update(
    actor: AuthPrincipal,
    id: string,
    dto: UpdateProcedureDefinitionDto,
    meta: RequestMeta,
  ) {
    return this.mutate(
      actor,
      id,
      dto.expectedVersion,
      meta,
      'UPDATED',
      (cur) => {
        const data: Record<string, unknown> = {};
        const fields: string[] = [];
        if (dto.name !== undefined && dto.name !== cur.name) {
          data['name'] = dto.name;
          fields.push('name');
        }
        if (
          dto.description !== undefined &&
          (dto.description || null) !== cur.description
        ) {
          data['description'] = dto.description || null;
          fields.push('description');
        }
        if (
          dto.requiresClinicalConsent !== undefined &&
          dto.requiresClinicalConsent !== cur.requiresClinicalConsent
        ) {
          data['requiresClinicalConsent'] = dto.requiresClinicalConsent;
          fields.push('requiresClinicalConsent');
        }
        return { data, fields };
      },
      dto.reason,
    );
  }

  setStatus(
    actor: AuthPrincipal,
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
    expectedVersion: number,
    reason: string,
    meta: RequestMeta,
  ) {
    return this.mutate(
      actor,
      id,
      expectedVersion,
      meta,
      status === 'ACTIVE' ? 'REACTIVATED' : 'DEACTIVATED',
      (cur) => {
        if (cur.status === status)
          throw new ConflictException({
            message: 'El procedimiento ya está en ese estado',
            code: 'INVALID_STATE',
          });
        return { data: { status }, fields: ['status'] };
      },
      reason,
    );
  }

  private async mutate(
    actor: AuthPrincipal,
    id: string,
    expectedVersion: number,
    meta: RequestMeta,
    kind: 'UPDATED' | 'DEACTIVATED' | 'REACTIVATED',
    plan: (cur: {
      name: string;
      description: string | null;
      requiresClinicalConsent: boolean;
      status: string;
    }) => { data: Record<string, unknown>; fields: string[] },
    reason: string,
  ) {
    const { clinicId, branchId } = this.clinicOf(actor);
    const row = await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM procedure_definitions WHERE id = ${id} AND clinic_id = ${clinicId} FOR UPDATE`;
          if (!locked[0])
            throw new NotFoundException('Procedimiento no encontrado');
          const cur = await tx.procedureDefinition.findUniqueOrThrow({
            where: { id },
          });
          if (cur.version !== expectedVersion)
            throw versionConflict(cur.version);
          const { data, fields } = plan(cur);
          if (fields.length === 0)
            throw new ConflictException({
              message: 'El cambio no modifica ningún campo',
              code: 'NO_CHANGES',
            });
          const updated = await tx.procedureDefinition.update({
            where: { id },
            data: {
              ...data,
              version: { increment: 1 },
              updatedById: actor.user.id,
            },
          });
          await this.record(
            tx,
            actor,
            clinicId,
            branchId,
            meta,
            kind,
            id,
            updated.version,
            fields,
            updated.requiresClinicalConsent,
            reason,
          );
          return updated;
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return present(row);
  }

  private record(
    tx: Parameters<Parameters<PrismaDb['$transaction']>[0]>[0],
    actor: AuthPrincipal,
    clinicId: string,
    branchId: string | null,
    meta: RequestMeta,
    kind: string,
    id: string,
    version: number,
    fields: string[],
    requiresClinicalConsent: boolean,
    reason?: string,
  ) {
    return this.audit.record(
      {
        action: `PROCEDURE_DEFINITION_${kind}`,
        entity: 'ProcedureDefinition',
        entityId: id,
        userId: actor.user.id,
        clinicId,
        branchId,
        meta,
        // Configuración de la clínica (no datos de pacientes): se puede registrar la política vigente y el motivo.
        summary: {
          version: version,
          fields,
          requiresClinicalConsent,
          ...(reason ? { reason } : {}),
        },
      },
      tx,
    );
  }
}
