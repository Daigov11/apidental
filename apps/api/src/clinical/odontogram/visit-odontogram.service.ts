import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../../audit/audit.service.js';
import type { AuthPrincipal } from '../../auth/auth.types.js';
import { ReauthPurposeDto } from '../../auth/dto/reauth.dto.js';
import { REAUTH_NOTICE, ReauthService } from '../../auth/reauth.service.js';
import type { RequestMeta } from '../../common/utils/request-meta.js';
import { withTxRetry } from '../../common/utils/tx-retry.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ageOn, formatDateOnly } from '../../patients/util/lima-date.js';
import { fullName } from '../../patients/patient-view.js';
import {
  isUniqueViolation,
  requirePatient,
} from '../../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../../prisma/client.js';
import { PRISMA } from '../../prisma/prisma.module.js';
import {
  ClinicalAccessService,
  type ClinicalAccessDecision,
} from '../clinical-access.service.js';
import {
  assertVisitWriter,
  lockVisitShared,
  withVisitDenial,
} from '../clinical-visit-access.js';
import { recordNotFound, stateConflict } from '../clinical-versioning.js';
import type {
  CloseVisitOdontogramDto,
  CorrectVisitOdontogramDto,
  DiscardOdontogramDto,
  SaveOdontogramDraftDto,
  StartVisitOdontogramDto,
} from '../dto/odontogram.dto.js';
import { renderVisitOdontogramPdf } from './odontogram-pdf.js';
import {
  type Dentition,
  emptyOdontogram,
  FORMAT_NOTICE,
  LEGEND,
  normalizeOdontogram,
} from './odontogram-spec.js';

export type VisitOdontogramPhase = 'DIAGNOSIS' | 'POST_TREATMENT';
export const VISIT_PHASES: readonly VisitOdontogramPhase[] = [
  'DIAGNOSIS',
  'POST_TREATMENT',
];
export const PHASE_LABELS: Record<VisitOdontogramPhase, string> = {
  DIAGNOSIS: 'Odontograma de diagnóstico',
  POST_TREATMENT: 'Odontograma post tratamiento',
};

type Kind = 'CREATED' | 'CLOSED' | 'CORRECTED' | 'DISCARDED';

export interface VisitOdontogramRow {
  id: string;
  clinicId: string;
  patientId: string;
  visitId: string;
  phase: VisitOdontogramPhase;
  version: number;
  supersedesId: string | null;
  currentKey: string | null;
  status: 'DRAFT' | 'CLOSED' | 'DISCARDED';
  dentition: Dentition;
  data: unknown;
  revision: number;
  changeKind: Kind;
  changeReason: string | null;
  contentHash: string | null;
  closedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

const STATE_LABELS = {
  DRAFT: 'Borrador',
  CLOSED: 'Guardado',
  CORRECTED: 'Corregido',
  DISCARDED: 'Descartado',
} as const;

const etagOf = (r: Pick<VisitOdontogramRow, 'version' | 'revision'>) =>
  `${r.version}.${r.revision}`;
const keyOf = (visitId: string, phase: VisitOdontogramPhase) =>
  `${visitId}|${phase}`;

/** Huella de integridad de una fase guardada (evidencia técnica; NO es una firma). */
export const visitOdontogramHash = (r: {
  visitId: string;
  phase: string;
  version: number;
  dentition: string;
  data: unknown;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        vi: r.visitId,
        ph: r.phase,
        v: r.version,
        d: r.dentition,
        c: r.data,
      }),
    )
    .digest('hex');

export function presentVisitOdontogram(
  r: VisitOdontogramRow,
  viewerIsAuthor: boolean,
) {
  const state =
    r.status === 'CLOSED' && r.changeKind === 'CORRECTED'
      ? 'CORRECTED'
      : r.status;
  const hidden = r.status === 'DRAFT' && !viewerIsAuthor;
  return {
    phase: r.phase,
    phaseLabel: PHASE_LABELS[r.phase],
    version: r.version,
    revision: r.revision,
    etag: etagOf(r),
    state,
    stateLabel: STATE_LABELS[state],
    kind: r.changeKind,
    dentition: r.dentition,
    dentitionLabel: LEGEND.dentition[r.dentition],
    data: hidden ? null : r.data,
    contentHidden: hidden,
    closure:
      r.status === 'CLOSED'
        ? {
            savedAt: r.closedAt,
            confirmedByUserId: r.createdById,
            integrityHash: r.contentHash,
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
  };
}

class ReauthFailed extends Error {}

/**
 * Odontograma POR VISITA en dos fases, como en la ficha en papel de la clínica: DIAGNÓSTICO (cómo llega el paciente) y
 * POST TRATAMIENTO (cómo sale). Cada fase es una cadena de versiones: un BORRADOR editable en el sitio por el odontólogo
 * responsable mientras la visita está abierta; al GUARDAR queda inmutable (huella de integridad). Una fase guardada solo
 * se cambia con una CORRECCIÓN (motivo + reautenticación, que NO es una firma). Al cerrar la visita, la última fase
 * guardada pasa a ser el odontograma vigente del paciente (ver `OdontogramService.promoteFromVisit`). La auditoría
 * guarda referencias y versión, nunca el contenido. FORMATO CLÍNICO POR VALIDAR: no se afirma cumplimiento MINSA.
 */
@Injectable()
export class VisitOdontogramService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
    private readonly reauth: ReauthService,
  ) {}

  // ------------------------------------------------------------------- lectura

  /** Ambas fases de la visita (con contenido, salvo borradores ajenos) y el odontograma vigente del paciente como base. */
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
      ['visit_odontogram'],
      meta,
      { allowLimited: false },
    );
    const visit = await this.db.clinicalVisit.findFirst({
      where: { id: visitId, clinicId: d.clinicId, patientId },
      select: { id: true, status: true, dentistUserId: true, branchId: true },
    });
    if (!visit) throw recordNotFound();
    const heads = await this.heads(this.db, visitId);
    const responsible =
      d.level === 'FULL' &&
      visit.dentistUserId === actor.user.id &&
      d.branchId === visit.branchId;
    const open = visit.status === 'OPEN';
    const diag = heads.DIAGNOSIS;
    const post = heads.POST_TREATMENT;
    const canWrite = responsible && open;
    return {
      phases: {
        DIAGNOSIS: diag
          ? presentVisitOdontogram(diag, diag.createdById === actor.user.id)
          : null,
        POST_TREATMENT: post
          ? presentVisitOdontogram(post, post.createdById === actor.user.id)
          : null,
      },
      actions: {
        canStartDiagnosis: canWrite && (!diag || diag.status === 'DISCARDED'),
        canStartPost:
          canWrite &&
          diag?.status === 'CLOSED' &&
          (!post || post.status === 'DISCARDED'),
        canCorrect: responsible,
      },
      formatNotice: FORMAT_NOTICE,
    };
  }

  // ---------------------------------------------------------------- escritura

  /** Abre el borrador de la fase: diagnóstico parte del odontograma vigente del paciente; post tratamiento, del diagnóstico guardado. */
  async start(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    phase: VisitOdontogramPhase,
    dto: StartVisitOdontogramDto,
    meta: RequestMeta,
  ) {
    const d = await this.authorizeWrite(
      actor,
      patientId,
      `${phase}:start`,
      meta,
    );
    const row = await this.write(actor, d, visitId, meta, async (tx) => {
      const cur = await this.lockHead(tx, visitId, phase);
      if (cur && cur.status !== 'DISCARDED')
        throw new ConflictException({
          message:
            cur.status === 'DRAFT'
              ? 'Ya hay un borrador de esta fase; continúe con él o descártelo'
              : 'Esta fase ya está guardada; para cambiarla, corríjala',
          code: cur.status === 'DRAFT' ? 'DRAFT_EXISTS' : 'ALREADY_SAVED',
          currentEtag: etagOf(cur),
        });
      let base: { dentition: Dentition; data: unknown } | null;
      if (phase === 'POST_TREATMENT') {
        const diag = await this.lockHead(tx, visitId, 'DIAGNOSIS');
        if (diag?.status !== 'CLOSED')
          throw new ConflictException({
            message:
              'Guarde primero el odontograma de diagnóstico; el post tratamiento parte de él',
            code: 'DIAGNOSIS_NOT_SAVED',
          });
        base = diag;
      } else {
        base = await this.patientOfficial(tx, d.clinicId, patientId);
      }
      const dentition = (dto.dentition ??
        base?.dentition ??
        'PERMANENT') as Dentition;
      const data = base
        ? normalizeOdontogram(base.data, dentition)
        : emptyOdontogram();
      if (cur)
        await tx.clinicalVisitOdontogram.update({
          where: { id: cur.id },
          data: { currentKey: null },
        });
      const created = (await tx.clinicalVisitOdontogram.create({
        data: {
          clinicId: d.clinicId,
          patientId,
          visitId,
          phase,
          version: (cur?.version ?? 0) + 1,
          supersedesId: cur?.id ?? null,
          currentKey: keyOf(visitId, phase),
          status: 'DRAFT',
          dentition,
          data: data as unknown as Prisma.InputJsonValue,
          changeKind: 'CREATED',
          createdById: actor.user.id,
        },
      })) as VisitOdontogramRow;
      await this.record(tx, actor, d, meta, 'DRAFT_STARTED', created, ['data']);
      return created;
    });
    return { odontogram: presentVisitOdontogram(row, true) };
  }

  /** Reemplaza el contenido del borrador en el sitio. Guardar lo mismo no cambia nada. */
  async saveDraft(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    phase: VisitOdontogramPhase,
    dto: SaveOdontogramDraftDto,
    meta: RequestMeta,
  ) {
    const d = await this.authorizeWrite(
      actor,
      patientId,
      `${phase}:save`,
      meta,
    );
    const row = await this.write(actor, d, visitId, meta, async (tx) => {
      const cur = await this.lockHead(tx, visitId, phase);
      if (cur?.status !== 'DRAFT') throw this.noDraft();
      if (etagOf(cur) !== dto.expectedEtag) throw this.etagConflict(cur);
      const dentition = (dto.dentition ?? cur.dentition) as Dentition;
      const data = normalizeOdontogram(dto.data, dentition);
      if (
        dentition === cur.dentition &&
        JSON.stringify(data) ===
          JSON.stringify(normalizeOdontogram(cur.data, cur.dentition))
      )
        return cur;
      const updated = (await tx.clinicalVisitOdontogram.update({
        where: { id: cur.id },
        data: {
          data: data as unknown as Prisma.InputJsonValue,
          dentition,
          revision: { increment: 1 },
        },
      })) as VisitOdontogramRow;
      await this.record(tx, actor, d, meta, 'DRAFT_SAVED', updated, [
        'data',
        ...(dentition !== cur.dentition ? ['dentition'] : []),
      ]);
      return updated;
    });
    return { odontogram: presentVisitOdontogram(row, true) };
  }

  /** Guarda la fase: pasa a inmutable, con huella de integridad. */
  async close(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    phase: VisitOdontogramPhase,
    dto: CloseVisitOdontogramDto,
    meta: RequestMeta,
  ) {
    const d = await this.authorizeWrite(
      actor,
      patientId,
      `${phase}:close`,
      meta,
    );
    const row = await this.write(actor, d, visitId, meta, async (tx) => {
      const cur = await this.lockHead(tx, visitId, phase);
      if (cur?.status !== 'DRAFT') throw this.noDraft();
      if (etagOf(cur) !== dto.expectedEtag) throw this.etagConflict(cur);
      const data = normalizeOdontogram(cur.data, cur.dentition);
      return this.supersede(tx, actor, d, meta, cur, {
        status: 'CLOSED',
        changeKind: 'CLOSED',
        dentition: cur.dentition,
        data,
      });
    });
    return { odontogram: presentVisitOdontogram(row, true) };
  }

  async discard(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    phase: VisitOdontogramPhase,
    dto: DiscardOdontogramDto,
    meta: RequestMeta,
  ) {
    const d = await this.authorizeWrite(
      actor,
      patientId,
      `${phase}:discard`,
      meta,
    );
    const row = await this.write(actor, d, visitId, meta, async (tx) => {
      const cur = await this.lockHead(tx, visitId, phase);
      if (cur?.status !== 'DRAFT') throw this.noDraft();
      if (etagOf(cur) !== dto.expectedEtag) throw this.etagConflict(cur);
      return this.supersede(tx, actor, d, meta, cur, {
        status: 'DISCARDED',
        changeKind: 'DISCARDED',
        dentition: cur.dentition,
        data: cur.data,
        reason: dto.reason,
      });
    });
    return { odontogram: presentVisitOdontogram(row, true) };
  }

  /**
   * Corrige una fase guardada con contenido nuevo (motivo + reautenticación). Se permite también con la visita cerrada,
   * pero entonces NO cambia el odontograma vigente del paciente: ese se corrige desde su propia página.
   */
  async correct(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    phase: VisitOdontogramPhase,
    dto: CorrectVisitOdontogramDto,
    meta: RequestMeta,
  ) {
    const d = await this.authorizeWrite(
      actor,
      patientId,
      `${phase}:correct`,
      meta,
    );
    const head = await this.db.clinicalVisitOdontogram.findUnique({
      where: { currentKey: keyOf(visitId, phase) },
      select: { id: true },
    });
    if (!head) throw recordNotFound();
    const proofToken = await this.reauth.proofFor(
      actor,
      dto,
      ReauthPurposeDto.CORRECT_VISIT_ODONTOGRAM,
      head.id,
      meta,
    );
    try {
      const row = await this.write(
        actor,
        d,
        visitId,
        meta,
        async (tx) => {
          const cur = await this.lockHead(tx, visitId, phase);
          if (!cur) throw recordNotFound();
          if (etagOf(cur) !== dto.expectedEtag) throw this.etagConflict(cur);
          if (cur.status !== 'CLOSED')
            throw stateConflict('Solo se corrige una fase guardada');
          const dentition = (dto.dentition ?? cur.dentition) as Dentition;
          const data = normalizeOdontogram(dto.data, dentition);
          if (
            dentition === cur.dentition &&
            JSON.stringify(data) ===
              JSON.stringify(normalizeOdontogram(cur.data, cur.dentition))
          )
            throw stateConflict('La corrección no cambia el odontograma');
          const proofId = await this.consume(
            actor,
            proofToken,
            head.id,
            meta,
            tx,
          );
          return this.supersede(tx, actor, d, meta, cur, {
            status: 'CLOSED',
            changeKind: 'CORRECTED',
            dentition,
            data,
            reason: dto.reason,
            proofId,
          });
        },
        { allowClosedVisit: true },
      );
      return {
        odontogram: presentVisitOdontogram(row, true),
        reauth: { required: true, isSignature: false, notice: REAUTH_NOTICE },
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

  // ----------------------------------------------------------------- exportar

  /** PDF con ambas fases guardadas de la visita y las piezas que cambiaron. */
  async export(
    actor: AuthPrincipal,
    patientId: string,
    visitId: string,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['visit_odontogram_export'],
      meta,
      { allowLimited: false },
    );
    const visit = await this.db.clinicalVisit.findFirst({
      where: { id: visitId, clinicId: d.clinicId, patientId },
      select: { visitNumber: true, startedAt: true, dentistUserId: true },
    });
    if (!visit) throw recordNotFound();
    const heads = await this.heads(this.db, visitId);
    const saved = VISIT_PHASES.map((p) => heads[p]).filter(
      (r): r is VisitOdontogramRow => r?.status === 'CLOSED',
    );
    if (saved.length === 0)
      throw new NotFoundException(
        'Aún no hay un odontograma guardado en esta visita',
      );
    try {
      await this.audit.record({
        action: 'CLINICAL_VISIT_ODONTOGRAM_EXPORTED',
        entity: 'ClinicalVisitOdontogram',
        entityId: visitId,
        patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          visitId,
          phases: saved.map((r) => `${r.phase}:v${r.version}`),
          format: 'pdf',
          via: d.via,
        },
      });
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo registrar la exportación; por seguridad no se entregó el documento',
      );
    }
    const [clinic, patient, dentist] = await Promise.all([
      this.db.clinic.findUniqueOrThrow({
        where: { id: d.clinicId },
        select: { name: true, brandDisplayName: true },
      }),
      this.db.patient.findFirstOrThrow({
        where: { id: patientId, clinicId: d.clinicId },
        select: {
          firstName: true,
          lastName: true,
          secondLastName: true,
          birthDate: true,
          identifiers: {
            where: { status: 'ACTIVE' },
            select: { type: true, number: true },
            take: 1,
          },
        },
      }),
      this.db.user.findUniqueOrThrow({
        where: { id: visit.dentistUserId },
        select: { firstName: true, lastName: true },
      }),
    ]);
    const pdf = await renderVisitOdontogramPdf({
      clinicName: clinic.brandDisplayName ?? clinic.name,
      patient: {
        fullName: fullName(patient),
        document: patient.identifiers[0]
          ? `${patient.identifiers[0].type} ${patient.identifiers[0].number}`
          : null,
        birthDate: formatDateOnly(patient.birthDate),
        age: patient.birthDate ? ageOn(patient.birthDate) : null,
      },
      visit: {
        number: visit.visitNumber,
        date: visit.startedAt,
        dentist: `${dentist.firstName} ${dentist.lastName}`,
      },
      phases: saved.map((r) => ({
        label: PHASE_LABELS[r.phase],
        version: r.version,
        stateLabel:
          STATE_LABELS[r.changeKind === 'CORRECTED' ? 'CORRECTED' : 'CLOSED'],
        savedAt: r.closedAt ?? r.createdAt,
        hash: r.contentHash,
        dentition: r.dentition,
        data: normalizeOdontogram(r.data, r.dentition),
      })),
      generatedAt: new Date(),
      generatedBy: `${actor.user.firstName} ${actor.user.lastName}`,
    });
    const stamp = visit.startedAt.toISOString().slice(0, 10);
    return {
      body: pdf,
      type: 'application/pdf',
      filename: `odontograma-visita-${visit.visitNumber}-${stamp}.pdf`,
    };
  }

  // -------------------------------------------------------- para el cierre de la visita

  /** Versión vigente de cada fase (dentro de la transacción del cierre o fuera de ella). */
  async heads(
    db: DbTx | PrismaDb,
    visitId: string,
  ): Promise<Record<VisitOdontogramPhase, VisitOdontogramRow | null>> {
    const rows = (await db.clinicalVisitOdontogram.findMany({
      where: { visitId, currentKey: { not: null } },
    })) as VisitOdontogramRow[];
    return {
      DIAGNOSIS: rows.find((r) => r.phase === 'DIAGNOSIS') ?? null,
      POST_TREATMENT: rows.find((r) => r.phase === 'POST_TREATMENT') ?? null,
    };
  }

  // ------------------------------------------------------------------ internos

  private async authorizeWrite(
    actor: AuthPrincipal,
    patientId: string,
    action: string,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      [`visit_odontogram:${action.toLowerCase()}`],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    return d;
  }

  /** Transacción: relación revalidada, visita bloqueada en modo compartido (el cierre la toma exclusiva), solo el responsable. */
  private async write<T>(
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    visitId: string,
    meta: RequestMeta,
    fn: (tx: DbTx) => Promise<T>,
    opts: { allowClosedVisit?: boolean } = {},
  ): Promise<T> {
    try {
      return await withVisitDenial(this.access, actor, d.patientId, meta, () =>
        withTxRetry(() =>
          this.db.$transaction(
            async (tx) => {
              await this.access.assertStillAuthorized(tx, actor, d, meta);
              const visit = await lockVisitShared(
                tx,
                visitId,
                d.clinicId,
                d.patientId,
              );
              assertVisitWriter(visit, actor, d);
              if (visit.status !== 'OPEN' && !opts.allowClosedVisit)
                throw stateConflict(
                  'La visita ya no está abierta; el odontograma de la visita se registra mientras está abierta',
                );
              if (visit.status === 'CANCELLED')
                throw stateConflict('La visita está cancelada');
              return fn(tx);
            },
            { isolationLevel: 'ReadCommitted' },
          ),
        ),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException({
          message:
            'El odontograma cambió desde que lo abrió; vuelva a cargarlo',
          code: 'VERSION_CONFLICT',
        });
      throw error;
    }
  }

  private async supersede(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    cur: VisitOdontogramRow,
    next: {
      status: 'CLOSED' | 'DISCARDED';
      changeKind: Kind;
      dentition: Dentition;
      data: unknown;
      reason?: string;
      proofId?: string;
    },
  ): Promise<VisitOdontogramRow> {
    const version = cur.version + 1;
    await tx.clinicalVisitOdontogram.update({
      where: { id: cur.id },
      data: { currentKey: null },
    });
    const closed = next.status === 'CLOSED';
    const created = (await tx.clinicalVisitOdontogram.create({
      data: {
        clinicId: cur.clinicId,
        patientId: cur.patientId,
        visitId: cur.visitId,
        phase: cur.phase,
        version,
        supersedesId: cur.id,
        currentKey: cur.currentKey,
        status: next.status,
        dentition: next.dentition,
        data: next.data as Prisma.InputJsonValue,
        changeKind: next.changeKind,
        changeReason: next.reason ?? null,
        contentHash: closed
          ? visitOdontogramHash({
              visitId: cur.visitId,
              phase: cur.phase,
              version,
              dentition: next.dentition,
              data: next.data,
            })
          : null,
        closedAt: closed ? new Date() : null,
        reauthProofId: next.proofId ?? null,
        createdById: actor.user.id,
      },
    })) as VisitOdontogramRow;
    await this.record(
      tx,
      actor,
      d,
      meta,
      next.changeKind,
      created,
      next.changeKind === 'DISCARDED' ? ['status'] : ['data'],
      !!next.proofId,
    );
    return created;
  }

  /** Vigente de la fase (bloqueada). Reintenta: si otra transacción la reemplazaba, al despertar toma la nueva. */
  private async lockHead(
    tx: DbTx,
    visitId: string,
    phase: VisitOdontogramPhase,
  ): Promise<VisitOdontogramRow | null> {
    const key = keyOf(visitId, phase);
    for (let attempt = 0; attempt < 3; attempt++) {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM clinical_visit_odontograms WHERE current_key = ${key} FOR UPDATE`;
      if (locked[0])
        return (await tx.clinicalVisitOdontogram.findUniqueOrThrow({
          where: { id: locked[0].id },
        })) as VisitOdontogramRow;
    }
    return null;
  }

  /** Versión vigente del odontograma del paciente (la última guardada que no se registró por error). */
  private async patientOfficial(
    tx: DbTx,
    clinicId: string,
    patientId: string,
  ): Promise<{ dentition: Dentition; data: unknown } | null> {
    const rows = await tx.clinicalOdontogram.findMany({
      where: { clinicId, patientId },
      orderBy: { version: 'asc' },
      select: {
        id: true,
        status: true,
        supersedesId: true,
        dentition: true,
        data: true,
      },
    });
    const errored = new Set(
      rows
        .filter((r) => r.status === 'ENTERED_IN_ERROR')
        .map((r) => r.supersedesId),
    );
    const official = rows
      .filter((r) => r.status === 'CLOSED' && !errored.has(r.id))
      .at(-1);
    return official
      ? { dentition: official.dentition as Dentition, data: official.data }
      : null;
  }

  private async consume(
    actor: AuthPrincipal,
    token: string,
    targetId: string,
    meta: RequestMeta,
    tx: DbTx,
  ): Promise<string> {
    try {
      return await this.reauth.consume(
        { userId: actor.user.id, sessionId: actor.sessionId },
        token,
        ReauthPurposeDto.CORRECT_VISIT_ODONTOGRAM,
        targetId,
        meta,
        tx,
      );
    } catch (error) {
      if ((error as { status?: number }).status === 403)
        throw new ReauthFailed();
      throw error;
    }
  }

  private noDraft() {
    return new ConflictException({
      message: 'No hay un borrador abierto de esta fase',
      code: 'NO_DRAFT',
    });
  }

  private etagConflict(cur: VisitOdontogramRow | null) {
    return new ConflictException({
      message:
        'El odontograma cambió desde que lo abrió; vuelva a cargarlo antes de guardar',
      code: 'VERSION_CONFLICT',
      currentEtag: cur ? etagOf(cur) : null,
    });
  }

  /** Referencias, fase y versión. NUNCA el contenido del odontograma ni el motivo. */
  private record(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    event: string,
    row: VisitOdontogramRow,
    fields: string[],
    reauthenticated = false,
  ) {
    return this.audit.record(
      {
        action: `CLINICAL_VISIT_ODONTOGRAM_${event}`,
        entity: 'ClinicalVisitOdontogram',
        entityId: row.visitId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          visitId: row.visitId,
          phase: row.phase,
          version: row.version,
          revision: row.revision,
          changeKind: row.changeKind,
          fields,
          via: d.via,
          ...(reauthenticated
            ? { reauthenticated: true, isSignature: false }
            : {}),
        },
      },
      tx,
    );
  }
}
