import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { ReauthenticateDto } from '../auth/dto/reauth.dto.js';
import { ReauthPurposeDto } from '../auth/dto/reauth.dto.js';
import { REAUTH_NOTICE, ReauthService } from '../auth/reauth.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import {
  isUniqueViolation,
  requirePatient,
} from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import {
  ClinicalAccessService,
  type ClinicalAccessDecision,
} from './clinical-access.service.js';
import {
  assertVisitWriter,
  lockVisitShared,
  withVisitDenial,
} from './clinical-visit-access.js';
import { recordNotFound, stateConflict } from './clinical-versioning.js';
import { noteContentHash } from './note-hash.js';
import type {
  CloseNoteDto,
  CorrectNoteDto,
  DiscardDraftDto,
  MarkNoteErrorDto,
  ReauthInput,
  SaveDraftDto,
} from './dto/care.dto.js';

type Kind =
  | 'CREATED'
  | 'CLOSED'
  | 'CORRECTED'
  | 'RECTIFIED'
  | 'DISCARDED'
  | 'MARKED_IN_ERROR';

export interface NoteRow {
  id: string;
  itemId: string;
  visitId: string;
  version: number;
  revision: number;
  status: string;
  body: string;
  followUp: string | null;
  changeKind: string;
  changeReason: string | null;
  contentHash: string | null;
  closedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const NOTE_STATE_LABELS = {
  DRAFT: 'Borrador',
  CLOSED: 'Cerrada',
  CORRECTED: 'Corregida',
  DISCARDED: 'Descartada',
  ENTERED_IN_ERROR: 'Registrada por error',
} as const;

const etagOf = (r: Pick<NoteRow, 'version' | 'revision'>) =>
  `${r.version}.${r.revision}`;

/**
 * Vista de una evolución. El BORRADOR es trabajo en curso del odontólogo responsable: los demás lectores autorizados
 * saben que existe un borrador pero no ven su texto. Los estados visibles son los de la clínica: Borrador, Cerrada,
 * Corregida (Descartada y Registrada por error son terminales).
 */
export function presentNote(r: NoteRow, viewerIsResponsible: boolean) {
  const state =
    r.status === 'CLOSED' &&
    (r.changeKind === 'CORRECTED' || r.changeKind === 'RECTIFIED')
      ? 'CORRECTED'
      : r.status;
  const hidden = r.status === 'DRAFT' && !viewerIsResponsible;
  return {
    id: r.itemId,
    visitId: r.visitId,
    version: r.version,
    revision: r.revision,
    etag: etagOf(r),
    state,
    stateLabel: NOTE_STATE_LABELS[state as keyof typeof NOTE_STATE_LABELS],
    body: hidden ? null : r.body,
    followUp: hidden ? null : r.followUp,
    contentHidden: hidden,
    closure:
      r.status === 'CLOSED'
        ? {
            closedAt: r.closedAt,
            confirmedByUserId: r.createdById,
            integrityHash: r.contentHash,
            // Confirmación de identidad con contraseña: NO es una firma digital, legal ni clínica.
            isSignature: false,
            notice: REAUTH_NOTICE,
          }
        : null,
    lastChange: {
      kind: r.changeKind,
      reason: r.changeReason,
      at: r.createdAt,
      byUserId: r.createdById,
    },
    declaredByProfessional: true,
  };
}

class ReauthFailed extends Error {}

/**
 * Evolución narrativa (una por visita). Flujo: el odontólogo responsable escribe un BORRADOR (se guarda en el sitio, con
 * `etag` para no pisar cambios) → la CIERRA confirmando su identidad (contraseña o prueba de reautenticación; no es una
 * firma) → queda una versión inmutable con huella de integridad. Una evolución cerrada no se edita ni se borra:
 * corregirla o rectificarla crea una versión nueva, enlazada a la anterior, con motivo y reautenticación.
 * Auditoría: referencias, versión y nombres de campos; NUNCA el texto de la evolución.
 * Sin recomendaciones automáticas, IA ni decisiones clínicas.
 */
@Injectable()
export class ClinicalNotesService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
    private readonly reauth: ReauthService,
  ) {}

  // ------------------------------------------------------------------- lectura

  async get(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['evolution'],
      meta,
      { allowLimited: false },
    );
    const visit = await this.db.clinicalVisit.findFirst({
      where: { id: visitId, clinicId: d.clinicId, patientId },
      select: { dentistUserId: true },
    });
    if (!visit) throw recordNotFound();
    const row = await this.db.clinicalNote.findFirst({
      where: {
        visitId,
        clinicId: d.clinicId,
        patientId,
        visitKey: { not: null },
      },
    });
    return {
      evolution: row
        ? presentNote(row as NoteRow, visit.dentistUserId === actor.user.id)
        : null,
    };
  }

  async versions(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['evolution_versions'],
      meta,
      { allowLimited: false },
    );
    const visit = await this.db.clinicalVisit.findFirst({
      where: { id: visitId, clinicId: d.clinicId, patientId },
      select: { dentistUserId: true },
    });
    if (!visit) throw recordNotFound();
    const latest = await this.db.clinicalNote.findFirst({
      where: {
        visitId,
        clinicId: d.clinicId,
        patientId,
        currentKey: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) return { versions: [] };
    const rows = await this.db.clinicalNote.findMany({
      where: { itemId: latest.itemId },
      orderBy: [{ version: 'desc' }],
    });
    const mine = visit.dentistUserId === actor.user.id;
    return { versions: rows.map((r) => presentNote(r as NoteRow, mine)) };
  }

  // ---------------------------------------------------------------- escritura

  /** Crea el borrador si no existe, o lo actualiza en el sitio. Idempotente: guardar lo mismo no cambia nada. */
  async saveDraft(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: SaveDraftDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['evolution:save'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const followUp = dto.followUp || null;
    let result: { row: NoteRow; created: boolean };
    try {
      result = await withVisitDenial(this.access, actor, patientId, meta, () =>
        withTxRetry(() =>
          this.db.$transaction(
            async (tx) => {
              await this.access.assertStillAuthorized(tx, actor, d, meta);
              const visit = await lockVisitShared(
                tx,
                visitId,
                d.clinicId,
                patientId,
              );
              assertVisitWriter(visit, actor, d);
              if (visit.status !== 'OPEN')
                throw stateConflict(
                  'La visita ya no está abierta; la evolución se redacta mientras la visita está abierta',
                );
              const cur = await this.lockActive(tx, visitId);
              if (!cur) {
                if (dto.expectedEtag) throw this.etagConflict(null);
                const itemId = randomUUID();
                const created = await tx.clinicalNote.create({
                  data: {
                    clinicId: d.clinicId,
                    patientId,
                    visitId,
                    itemId,
                    version: 1,
                    currentKey: itemId,
                    visitKey: visitId,
                    status: 'DRAFT',
                    body: dto.body,
                    followUp,
                    changeKind: 'CREATED',
                    createdById: actor.user.id,
                  },
                });
                await this.record(
                  tx,
                  actor,
                  d,
                  meta,
                  'CREATED',
                  created as NoteRow,
                  ['body', 'followUp'],
                );
                return { row: created as NoteRow, created: true };
              }
              if (cur.status !== 'DRAFT') throw this.notDraft();
              if (dto.expectedEtag !== etagOf(cur))
                throw this.etagConflict(cur);
              if (cur.body === dto.body && (cur.followUp ?? null) === followUp)
                return { row: cur, created: false };
              const fields = [
                ...(cur.body !== dto.body ? ['body'] : []),
                ...((cur.followUp ?? null) !== followUp ? ['followUp'] : []),
              ];
              const updated = await tx.clinicalNote.update({
                where: { id: cur.id },
                data: { body: dto.body, followUp, revision: { increment: 1 } },
              });
              await this.record(
                tx,
                actor,
                d,
                meta,
                'DRAFT_SAVED',
                updated as NoteRow,
                fields,
              );
              return { row: updated as NoteRow, created: false };
            },
            { isolationLevel: 'ReadCommitted' },
          ),
        ),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Otra persona creó el borrador a la vez: se informa el etag vigente para que el cliente vuelva a leer.
        const now = await this.db.clinicalNote.findFirst({
          where: { visitId, visitKey: { not: null } },
        });
        throw this.etagConflict(now as NoteRow | null);
      }
      throw error;
    }
    return {
      created: result.created,
      evolution: presentNote(result.row, true),
    };
  }

  /** Cierra el borrador: versión inmutable con huella de integridad. Exige reautenticación (no es una firma). */
  async close(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: CloseNoteDto,
    meta: RequestMeta,
  ) {
    return this.finalize(actor, patientId, visitId, dto, meta, {
      kind: 'CLOSED',
      purpose: ReauthPurposeDto.CLOSE_CLINICAL_NOTE,
      fromStatus: 'DRAFT',
      reason: null,
      content: null,
    });
  }

  correct(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: CorrectNoteDto,
    kind: 'CORRECTED' | 'RECTIFIED',
    meta: RequestMeta,
  ) {
    return this.finalize(actor, patientId, visitId, dto, meta, {
      kind,
      purpose: ReauthPurposeDto.CORRECT_CLINICAL_NOTE,
      fromStatus: 'CLOSED',
      reason: dto.reason,
      content: { body: dto.body, followUp: dto.followUp },
    });
  }

  markError(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: MarkNoteErrorDto,
    meta: RequestMeta,
  ) {
    return this.finalize(actor, patientId, visitId, dto, meta, {
      kind: 'MARKED_IN_ERROR',
      purpose: ReauthPurposeDto.MARK_CLINICAL_NOTE_ERROR,
      fromStatus: 'CLOSED',
      reason: dto.reason,
      content: null,
    });
  }

  /** Descarta un borrador (queda en el historial; no se borra). No requiere reautenticación. */
  async discard(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: DiscardDraftDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['evolution:discard'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const row = await withVisitDenial(this.access, actor, patientId, meta, () =>
      withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await this.access.assertStillAuthorized(tx, actor, d, meta);
            const visit = await lockVisitShared(
              tx,
              visitId,
              d.clinicId,
              patientId,
            );
            assertVisitWriter(visit, actor, d);
            const cur = await this.lockActive(tx, visitId);
            if (!cur) throw recordNotFound();
            if (etagOf(cur) !== dto.expectedEtag) throw this.etagConflict(cur);
            if (cur.status !== 'DRAFT')
              throw stateConflict('Solo se descarta un borrador');
            return this.supersede(tx, actor, d, meta, cur, {
              kind: 'DISCARDED',
              status: 'DISCARDED',
              body: cur.body,
              followUp: cur.followUp,
              reason: dto.reason,
              closure: null,
            });
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      ),
    );
    return { evolution: presentNote(row, true) };
  }

  // ------------------------------------------------------------------ internos

  private async finalize(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    dto: ReauthInput & { expectedEtag: string },
    meta: RequestMeta,
    op: {
      kind: 'CLOSED' | 'CORRECTED' | 'RECTIFIED' | 'MARKED_IN_ERROR';
      purpose: ReauthPurposeDto;
      fromStatus: 'DRAFT' | 'CLOSED';
      reason: string | null;
      content: { body?: string; followUp?: string | null } | null;
    },
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      [`evolution:${op.kind.toLowerCase()}`],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    // El itemId es el objeto de la reautenticación: la prueba solo sirve para ESTA evolución.
    const current = await this.db.clinicalNote.findFirst({
      where: {
        visitId,
        clinicId: d.clinicId,
        patientId,
        visitKey: { not: null },
      },
      select: { itemId: true },
    });
    if (!current) {
      await this.assertVisitExists(visitId, d.clinicId, patientId);
      throw recordNotFound();
    }
    const proofToken = await this.obtainProof(
      actor,
      dto,
      op.purpose,
      current.itemId,
      meta,
    );
    try {
      const row = await withVisitDenial(
        this.access,
        actor,
        patientId,
        meta,
        () =>
          withTxRetry(() =>
            this.db.$transaction(
              async (tx) => {
                await this.access.assertStillAuthorized(tx, actor, d, meta);
                const visit = await lockVisitShared(
                  tx,
                  visitId,
                  d.clinicId,
                  patientId,
                );
                assertVisitWriter(visit, actor, d);
                const cur = await this.lockActive(tx, visitId);
                if (!cur || cur.itemId !== current.itemId)
                  throw recordNotFound();
                if (etagOf(cur) !== dto.expectedEtag)
                  throw this.etagConflict(cur);
                if (cur.status !== op.fromStatus) {
                  throw op.fromStatus === 'DRAFT'
                    ? stateConflict('La evolución ya está cerrada')
                    : stateConflict('Solo se corrige una evolución cerrada');
                }
                if (op.kind === 'CLOSED' && visit.status !== 'OPEN')
                  throw stateConflict(
                    'La visita ya no está abierta; no se puede cerrar la evolución',
                  );
                let body = cur.body;
                let followUp = cur.followUp ?? null;
                if (op.content) {
                  if (op.content.body !== undefined) body = op.content.body;
                  if (op.content.followUp !== undefined)
                    followUp = op.content.followUp || null;
                  if (body === cur.body && followUp === (cur.followUp ?? null))
                    throw new BadRequestException(
                      'La corrección no modifica el contenido',
                    );
                }
                let proofId: string;
                try {
                  proofId = await this.reauth.consume(
                    { userId: actor.user.id, sessionId: actor.sessionId },
                    proofToken,
                    op.purpose,
                    cur.itemId,
                    meta,
                    tx,
                  );
                } catch (error) {
                  if ((error as { status?: number }).status === 403)
                    throw new ReauthFailed();
                  throw error;
                }
                const status =
                  op.kind === 'MARKED_IN_ERROR' ? 'ENTERED_IN_ERROR' : 'CLOSED';
                return this.supersede(tx, actor, d, meta, cur, {
                  kind: op.kind,
                  status,
                  body,
                  followUp,
                  reason: op.reason,
                  closure: { proofId },
                });
              },
              { isolationLevel: 'ReadCommitted' },
            ),
          ),
      );
      return {
        evolution: presentNote(row, true),
        reauth: { isSignature: false, notice: REAUTH_NOTICE },
      };
    } catch (error) {
      if (error instanceof ReauthFailed) {
        await this.access.denyBy(actor, patientId, meta, {
          reason: 'reauthentication_failed',
          code: 'REAUTHENTICATION_REQUIRED',
          message: 'Reautenticación inválida, vencida o ya utilizada',
        });
      }
      throw error;
    }
  }

  /** Reemplaza la versión vigente por una nueva (enlazada), dentro de la transacción y con auditoría. */
  private async supersede(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    cur: NoteRow,
    next: {
      kind: Exclude<Kind, 'CREATED'>;
      status: 'CLOSED' | 'DISCARDED' | 'ENTERED_IN_ERROR';
      body: string;
      followUp: string | null;
      reason: string | null;
      closure: { proofId: string } | null;
    },
  ): Promise<NoteRow> {
    await tx.clinicalNote.update({
      where: { id: cur.id },
      data: { currentKey: null, visitKey: null },
    });
    const version = cur.version + 1;
    const hashed = next.status === 'CLOSED' || next.kind === 'MARKED_IN_ERROR';
    const created = await tx.clinicalNote.create({
      data: {
        clinicId: d.clinicId,
        patientId: d.patientId,
        visitId: cur.visitId,
        itemId: cur.itemId,
        version,
        supersedesId: cur.id,
        currentKey: cur.itemId,
        visitKey: next.status === 'CLOSED' ? cur.visitId : null,
        status: next.status,
        body: next.body,
        followUp: next.followUp,
        revision: 0,
        changeKind: next.kind,
        changeReason: next.reason,
        contentHash:
          next.status === 'CLOSED'
            ? noteContentHash({
                itemId: cur.itemId,
                version,
                visitId: cur.visitId,
                patientId: d.patientId,
                body: next.body,
                followUp: next.followUp,
              })
            : null,
        closedAt: next.status === 'CLOSED' ? new Date() : null,
        reauthProofId: hashed ? (next.closure?.proofId ?? null) : null,
        createdById: actor.user.id,
      },
    });
    const fields =
      next.kind === 'CORRECTED' || next.kind === 'RECTIFIED'
        ? [
            ...(next.body !== cur.body ? ['body'] : []),
            ...(next.followUp !== (cur.followUp ?? null) ? ['followUp'] : []),
          ]
        : ['status'];
    await this.record(
      tx,
      actor,
      d,
      meta,
      next.kind,
      created as NoteRow,
      fields,
    );
    return created as NoteRow;
  }

  /**
   * Bloquea la evolución activa de la visita. Si otra transacción la está reemplazando, al despertar ya no cumple la
   * condición (la marca de vigente pasó a la versión nueva): se vuelve a leer para tomar la vigente actual.
   */
  private async lockActive(tx: DbTx, visitId: string): Promise<NoteRow | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM clinical_notes WHERE visit_id = ${visitId} AND visit_key IS NOT NULL FOR UPDATE`;
      if (locked[0])
        return (await tx.clinicalNote.findUniqueOrThrow({
          where: { id: locked[0].id },
        })) as NoteRow;
    }
    return null;
  }

  private async assertVisitExists(
    visitId: string,
    clinicId: string,
    patientId: string,
  ): Promise<void> {
    const v = await this.db.clinicalVisit.findFirst({
      where: { id: visitId, clinicId, patientId },
      select: { id: true },
    });
    if (!v) throw recordNotFound();
  }

  /** Contraseña (un paso) o prueba previa. La contraseña se verifica con el mismo control de intentos que `reauthenticate`. */
  private async obtainProof(
    actor: AuthPrincipal,
    dto: ReauthInput,
    purpose: ReauthPurposeDto,
    targetId: string,
    meta: RequestMeta,
  ): Promise<string> {
    if (dto.password && dto.reauthToken)
      throw new BadRequestException(
        'Indique la contraseña o la prueba de reautenticación, no ambas',
      );
    if (dto.reauthToken) return dto.reauthToken;
    if (!dto.password)
      throw new BadRequestException('Confirme su identidad con su contraseña');
    const issued = await this.reauth.issue(
      actor,
      { password: dto.password, purpose, targetId } as ReauthenticateDto,
      meta,
    );
    return issued.reauthToken;
  }

  private notDraft() {
    return new ConflictException({
      message:
        'La evolución ya está cerrada; para cambiarla use corregir o rectificar',
      code: 'NOT_A_DRAFT',
    });
  }

  private etagConflict(cur: NoteRow | null) {
    // Solo el etag actual: nada del contenido.
    return new ConflictException({
      message:
        'La evolución cambió desde que la abrió; vuelva a cargarla antes de guardar',
      code: 'VERSION_CONFLICT',
      currentEtag: cur ? etagOf(cur) : null,
    });
  }

  /** Referencias, versión y nombres de campos. Jamás el texto de la evolución ni el motivo. */
  private record(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    kind: Kind | 'DRAFT_SAVED',
    row: NoteRow,
    fields: string[],
  ) {
    return this.audit.record(
      {
        action: `CLINICAL_NOTE_${kind}`,
        entity: 'ClinicalNote',
        entityId: row.itemId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          itemId: row.itemId,
          visitId: row.visitId,
          version: row.version,
          revision: row.revision,
          changeKind: kind,
          fields,
          via: d.via,
          ...(kind === 'CLOSED' ||
          kind === 'CORRECTED' ||
          kind === 'RECTIFIED' ||
          kind === 'MARKED_IN_ERROR'
            ? { reauthenticated: true, isSignature: false }
            : {}),
        },
      },
      tx,
    );
  }
}
