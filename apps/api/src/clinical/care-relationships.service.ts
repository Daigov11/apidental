import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import {
  clinicScope,
  isUniqueViolation,
  requirePatient,
} from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type {
  CreateCareRelationshipDto,
  ListCareRelationshipsQuery,
} from './dto/clinical.dto.js';

const VIEW = {
  id: true,
  clinicId: true,
  patientId: true,
  dentistUserId: true,
  branchId: true,
  source: true,
  status: true,
  startedAt: true,
  validUntil: true,
  reason: true,
  createdById: true,
  endedAt: true,
  endedById: true,
  endKind: true,
  endReason: true,
  dentist: { select: { firstName: true, lastName: true } },
} as const;

type Row = {
  id: string;
  clinicId: string;
  patientId: string;
  dentistUserId: string;
  branchId: string | null;
  source: string;
  status: string;
  startedAt: Date;
  validUntil: Date | null;
  reason: string | null;
  createdById: string;
  endedAt: Date | null;
  endedById: string | null;
  endKind: string | null;
  endReason: string | null;
  dentist: { firstName: string; lastName: string };
};

const present = (r: Row) => ({
  id: r.id,
  patientId: r.patientId,
  dentist: {
    userId: r.dentistUserId,
    name: `${r.dentist.firstName} ${r.dentist.lastName}`,
  },
  branchId: r.branchId,
  source: r.source,
  status: r.status,
  startedAt: r.startedAt,
  validUntil: r.validUntil,
  reason: r.reason,
  createdById: r.createdById,
  endedAt: r.endedAt,
  endedById: r.endedById,
  endKind: r.endKind,
  endReason: r.endReason,
});

/**
 * Relación asistencial paciente–odontólogo–clínica (acto ADMINISTRATIVO: `care:assign`, no da acceso clínico a quien
 * la crea). Reglas:
 *  - explícita y dentro de la clínica del contexto; el odontólogo debe tener un rol DENTIST vigente en ella
 *    (404 uniforme si no: no se revela si el usuario existe en otra clínica);
 *  - nadie se asigna pacientes a sí mismo, ni a un odontólogo cuyo rol clínico él mismo otorgó (separación de
 *    funciones: frena la "segunda identidad" propia);
 *  - un administrador limitado a una sede solo crea y revoca relaciones de esa sede;
 *  - una vigente por (paciente, odontólogo, sede); nunca se borra: termina con motivo.
 * Las fuentes CITA y VISITA están reservadas: se rechazan hasta que existan esos módulos.
 */
@Injectable()
export class CareRelationshipsService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  async create(
    actor: AuthPrincipal,
    patientId: string,
    dto: CreateCareRelationshipDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId: ctxBranch } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });

    if (dto.dentistUserId === actor.user.id) {
      await this.blocked(actor, patientId, 'self_assignment', meta);
      throw new ForbiddenException(
        'No puede asignarse pacientes a sí mismo; lo debe hacer otra persona autorizada',
      );
    }
    // Un administrador de una sola sede no opera fuera de ella.
    if (ctxBranch && dto.branchId && dto.branchId !== ctxBranch) {
      throw new ForbiddenException('Su contexto está limitado a una sede');
    }
    const branchId = dto.branchId ?? ctxBranch;
    if (branchId) {
      const branch = await this.db.branch.findFirst({
        where: { id: branchId, clinicId },
        select: { status: true },
      });
      if (!branch || branch.status !== 'ACTIVE')
        throw new BadRequestException(
          'La sede no existe en esta clínica o está inactiva',
        );
    }

    try {
      const row = await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            // Bloqueo del odontólogo: serializa con retiro de rol y deshabilitación (que lo toman antes de cerrar relaciones).
            const locked = await tx.$queryRaw<
              { status: string }[]
            >`SELECT status FROM users WHERE id = ${dto.dentistUserId} FOR UPDATE`;
            const roles =
              locked[0]?.status === 'ACTIVE'
                ? await this.dentistRoles(
                    tx,
                    clinicId,
                    dto.dentistUserId,
                    branchId,
                  )
                : [];
            if (roles.length === 0)
              throw new NotFoundException(
                'Odontólogo no encontrado en esta clínica',
              );
            // Separación de funciones: quien otorgó el rol clínico no asigna pacientes a esa cuenta.
            if (roles.some((r) => r.grantedById === actor.user.id)) {
              throw new SeparationOfDutiesError();
            }
            const created = await tx.patientCareRelationship.create({
              data: {
                clinicId,
                patientId,
                dentistUserId: dto.dentistUserId,
                branchId,
                source: 'ASSIGNMENT',
                status: 'ACTIVE',
                activeKey: `${patientId}|${dto.dentistUserId}|${branchId ?? '*'}`,
                reason: dto.reason || null,
                createdById: actor.user.id,
              },
              select: VIEW,
            });
            await this.audit.record(
              {
                action: AuditAction.CareRelationshipCreated,
                entity: 'PatientCareRelationship',
                entityId: created.id,
                patientId,
                userId: actor.user.id,
                clinicId,
                branchId,
                meta,
                summary: {
                  dentistUserId: dto.dentistUserId,
                  source: 'ASSIGNMENT',
                  scope: branchId ? 'branch' : 'clinic',
                  hasReason: Boolean(dto.reason),
                },
              },
              tx,
            );
            return created;
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
      return present(row as Row);
    } catch (error) {
      if (error instanceof SeparationOfDutiesError) {
        await this.blocked(actor, patientId, 'separation_of_duties', meta);
        throw new ForbiddenException(
          'No puede asignar pacientes a un odontólogo cuyo rol clínico usted mismo otorgó; lo debe hacer otra persona autorizada',
        );
      }
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          message:
            'Ya existe una relación asistencial vigente para ese paciente, odontólogo y sede',
          code: 'RELATIONSHIP_EXISTS',
        });
      }
      throw error;
    }
  }

  async revoke(
    actor: AuthPrincipal,
    relationshipId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId: ctxBranch } = clinicScope(actor);
    const found = await this.db.patientCareRelationship.findFirst({
      where: { id: relationshipId, clinicId },
      select: { id: true, branchId: true },
    });
    // 404 uniforme: ajena, de otra sede o inexistente.
    if (!found || (ctxBranch && found.branchId !== ctxBranch))
      throw new NotFoundException('Relación asistencial no encontrada');

    const row = await withTxRetry(() =>
      this.db.$transaction(
        async (tx) => {
          // Dos revocaciones simultáneas se serializan: la segunda ve la relación ya terminada.
          const locked = await tx.$queryRaw<
            { status: string }[]
          >`SELECT status FROM patient_care_relationships WHERE id = ${relationshipId} FOR UPDATE`;
          if (locked[0]?.status !== 'ACTIVE') {
            throw new ConflictException({
              message: 'La relación asistencial ya no está vigente',
              code: 'RELATIONSHIP_NOT_ACTIVE',
            });
          }
          const ended = await tx.patientCareRelationship.update({
            where: { id: relationshipId },
            data: {
              status: 'ENDED',
              activeKey: null,
              endedAt: new Date(),
              endedById: actor.user.id,
              endKind: 'REVOKED',
              endReason: reason,
            },
            select: VIEW,
          });
          await this.audit.record(
            {
              action: AuditAction.CareRelationshipRevoked,
              entity: 'PatientCareRelationship',
              entityId: relationshipId,
              patientId: ended.patientId,
              userId: actor.user.id,
              clinicId,
              branchId: ended.branchId,
              meta,
              summary: { dentistUserId: ended.dentistUserId, reason },
            },
            tx,
          );
          return ended;
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
    return present(row as Row);
  }

  async listForPatient(
    actor: AuthPrincipal,
    patientId: string,
    status: 'ACTIVE' | 'ENDED' | undefined,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    const rows = await this.db.patientCareRelationship.findMany({
      where: {
        clinicId,
        patientId,
        ...(status ? { status } : {}),
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
      select: VIEW,
      take: 200,
    });
    await this.audit.record({
      action: AuditAction.CareRelationshipsListed,
      entity: 'Patient',
      entityId: patientId,
      patientId,
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { count: rows.length },
    });
    return rows.map((r) => present(r as Row));
  }

  /** Vista de la clínica para revisión: quién asignó, a quién y con qué origen de rol. */
  async listClinic(
    actor: AuthPrincipal,
    q: ListCareRelationshipsQuery,
    limit: number,
    offset: number,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    const rows = await this.db.patientCareRelationship.findMany({
      where: {
        clinicId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.dentistUserId ? { dentistUserId: q.dentistUserId } : {}),
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
      select: VIEW,
      take: limit,
      skip: offset,
    });
    // ¿Quién otorgó el rol de cada odontólogo? Permite al Director detectar autoasignaciones por segunda identidad.
    const dentistIds = [...new Set(rows.map((r) => r.dentistUserId))];
    const grants = dentistIds.length
      ? await this.db.userAssignment.findMany({
          where: {
            clinicId,
            userId: { in: dentistIds },
            status: 'ACTIVE',
            role: { code: 'DENTIST' },
          },
          select: { userId: true, grantedById: true },
        })
      : [];
    const grantorOf = new Map(grants.map((g) => [g.userId, g.grantedById]));
    await this.audit.record({
      action: AuditAction.CareRelationshipsListed,
      entity: 'Clinic',
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { count: rows.length, scope: 'clinic' },
    });
    return rows.map((r) => ({
      ...present(r as Row),
      dentistRoleGrantedById: grantorOf.get(r.dentistUserId) ?? null,
    }));
  }

  /** Roles DENTIST vigentes del usuario en la clínica (y en la sede, si la relación es de una sede). */
  private dentistRoles(
    tx: DbTx,
    clinicId: string,
    userId: string,
    branchId: string | null,
  ) {
    return tx.userAssignment.findMany({
      where: {
        userId,
        clinicId,
        status: 'ACTIVE',
        role: { code: 'DENTIST' },
        clinic: { is: { status: 'ACTIVE' } },
        ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : {}),
      },
      select: { id: true, grantedById: true },
    });
  }

  private blocked(
    actor: AuthPrincipal,
    patientId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    return this.audit.recordSafely({
      action: AuditAction.EscalationBlocked,
      entity: 'PatientCareRelationship',
      patientId,
      userId: actor.user.id,
      clinicId: actor.context?.clinicId ?? null,
      branchId: actor.context?.branchId ?? null,
      meta,
      summary: { reason, operation: 'care_assign' },
    });
  }
}

class SeparationOfDutiesError extends Error {}
