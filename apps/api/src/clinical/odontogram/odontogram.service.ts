import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import type { AuthPrincipal } from '../../auth/auth.types.js';
import { ReauthPurposeDto } from '../../auth/dto/reauth.dto.js';
import { REAUTH_NOTICE, ReauthService } from '../../auth/reauth.service.js';
import type { RequestMeta } from '../../common/utils/request-meta.js';
import { withTxRetry } from '../../common/utils/tx-retry.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { formatDateOnly, ageOn } from '../../patients/util/lima-date.js';
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
import { ClinicalAllergyAssessmentService } from '../clinical-allergy-assessment.service.js';
import { recordNotFound, stateConflict } from '../clinical-versioning.js';
import type {
  CloseOdontogramDto,
  DiscardOdontogramDto,
  ExportOdontogramQuery,
  MarkOdontogramErrorDto,
  SaveOdontogramDraftDto,
  StartOdontogramDraftDto,
} from '../dto/odontogram.dto.js';
import { renderOdontogramPdf } from './odontogram-pdf.js';
import {
  type Dentition,
  emptyOdontogram,
  FORMAT_NOTICE,
  LEGEND,
  normalizeOdontogram,
  odontogramHash,
  odontogramSpec,
} from './odontogram-spec.js';
import { renderOdontogramSvg } from './odontogram-svg.js';

type Kind =
  | 'CREATED'
  | 'UPDATED'
  | 'CORRECTED'
  | 'RECTIFIED'
  | 'DISCARDED'
  | 'MARKED_IN_ERROR';

interface Row {
  id: string;
  patientId: string;
  version: number;
  supersedesId: string | null;
  status: string;
  dentition: Dentition;
  data: unknown;
  revision: number;
  changeKind: string;
  changeReason: string | null;
  contentHash: string | null;
  closedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

const STATE_LABELS = {
  DRAFT: 'Borrador',
  CLOSED: 'Guardada',
  CORRECTED: 'Corregida',
  DISCARDED: 'Descartada',
  ENTERED_IN_ERROR: 'Registrada por error',
} as const;
const KIND_LABELS = {
  CREATED: 'Primer registro',
  UPDATED: 'Actualización',
  CORRECTED: 'Corrección',
  RECTIFIED: 'Rectificación',
  DISCARDED: 'Descartado',
  MARKED_IN_ERROR: 'Registro por error',
} as const;
const etagOf = (r: Pick<Row, 'version' | 'revision'>) =>
  `${r.version}.${r.revision}`;

export function presentOdontogram(
  r: Row,
  viewerIsAuthor: boolean,
  withData = true,
) {
  const state =
    r.status === 'CLOSED' &&
    (r.changeKind === 'CORRECTED' || r.changeKind === 'RECTIFIED')
      ? 'CORRECTED'
      : r.status;
  const hidden = r.status === 'DRAFT' && !viewerIsAuthor;
  return {
    version: r.version,
    revision: r.revision,
    etag: etagOf(r),
    state,
    stateLabel: STATE_LABELS[state as keyof typeof STATE_LABELS],
    kind: r.changeKind,
    kindLabel: KIND_LABELS[r.changeKind as keyof typeof KIND_LABELS],
    dentition: r.dentition,
    dentitionLabel: LEGEND.dentition[r.dentition],
    data: hidden || !withData ? null : r.data,
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
    formatNotice: FORMAT_NOTICE,
    declaredByProfessional: true,
  };
}

/** La versión vigente: la última guardada que NO se registró por error. */
function officialOf(
  rows: { id: string; status: string; supersedesId: string | null }[],
): { id: string } | null {
  const errored = new Set(
    rows
      .filter((r) => r.status === 'ENTERED_IN_ERROR')
      .map((r) => r.supersedesId),
  );
  const closed = rows.filter(
    (r) => r.status === 'CLOSED' && !errored.has(r.id),
  );
  return closed.at(-1) ?? null;
}

class DraftAuthorError extends Error {}
class ReauthFailed extends Error {}

/**
 * Odontograma versionado por paciente. Un BORRADOR editable en el sitio por el odontólogo que lo abrió; al GUARDAR la
 * versión queda inmutable (huella de integridad). Una versión guardada nunca se sobrescribe: cambiar algo abre un borrador
 * nuevo (actualización, corrección o rectificación). Corregir y rectificar exigen motivo y reautenticación (que NO es una
 * firma) al guardar; marcar una versión por error también. Pasa por el motor de acceso clínico; la auditoría guarda
 * referencias y versión, nunca el contenido. No genera tratamientos, presupuestos ni diagnósticos, ni recomienda nada.
 * FORMATO CLÍNICO POR VALIDAR: no se afirma cumplimiento MINSA.
 */
@Injectable()
export class OdontogramService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly access: ClinicalAccessService,
    private readonly reauth: ReauthService,
    private readonly patientLock: ClinicalAllergyAssessmentService,
  ) {}

  spec() {
    return odontogramSpec();
  }

  // ------------------------------------------------------------------- lectura

  async get(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['odontogram'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.chain(d.clinicId, patientId);
    const official = officialOf(rows);
    const current = rows.at(-1) ?? null;
    const [officialRow, draftRow] = await Promise.all([
      official
        ? this.db.clinicalOdontogram.findUnique({ where: { id: official.id } })
        : null,
      current?.status === 'DRAFT'
        ? this.db.clinicalOdontogram.findUnique({ where: { id: current.id } })
        : null,
    ]);
    return {
      official: officialRow
        ? presentOdontogram(officialRow as Row, true)
        : null,
      draft: draftRow
        ? presentOdontogram(
            draftRow as Row,
            draftRow.createdById === actor.user.id,
          )
        : null,
      draftIsMine: draftRow ? draftRow.createdById === actor.user.id : false,
      versionsCount: rows.length,
      formatNotice: FORMAT_NOTICE,
    };
  }

  async versions(actor: AuthPrincipal, patientId: string, meta: RequestMeta) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['odontogram_versions'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.db.clinicalOdontogram.findMany({
      where: { clinicId: d.clinicId, patientId },
      orderBy: { version: 'desc' },
      take: 100,
    });
    return {
      versions: rows.map((r) =>
        presentOdontogram(r as Row, r.createdById === actor.user.id),
      ),
      formatNotice: FORMAT_NOTICE,
    };
  }

  // ---------------------------------------------------------------- borrador

  /** Abre el primer odontograma (borrador vacío) o un borrador nuevo sobre la última versión guardada. */
  async startDraft(
    actor: AuthPrincipal,
    patientId: string,
    dto: StartOdontogramDraftDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['odontogram:start'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    if (
      (dto.purpose === 'CORRECTION' || dto.purpose === 'RECTIFICATION') &&
      !dto.reason
    ) {
      throw new BadRequestException(
        'Corregir o rectificar exige indicar el motivo',
      );
    }
    const row = await this.write(actor, d, patientId, meta, async (tx) => {
      const cur = await this.lockCurrent(tx, patientId, d.clinicId);
      if (cur?.status === 'DRAFT') {
        throw new ConflictException({
          message: 'Ya hay un borrador abierto; continúe con él o descártelo',
          code: 'DRAFT_EXISTS',
          currentEtag: etagOf(cur),
        });
      }
      const all = await tx.clinicalOdontogram.findMany({
        where: { patientId, clinicId: d.clinicId },
        select: { id: true, status: true, supersedesId: true },
      });
      const official = officialOf(all);
      const base = official
        ? ((await tx.clinicalOdontogram.findUniqueOrThrow({
            where: { id: official.id },
          })) as Row)
        : null;
      let kind: Kind;
      if (!cur) {
        if (dto.purpose)
          throw new BadRequestException(
            'El primer odontograma no lleva propósito',
          );
        kind = 'CREATED';
      } else {
        const purpose = dto.purpose ?? 'UPDATE';
        if (purpose !== 'UPDATE' && !base)
          throw stateConflict('No hay una versión guardada que corregir');
        kind =
          purpose === 'CORRECTION'
            ? 'CORRECTED'
            : purpose === 'RECTIFICATION'
              ? 'RECTIFIED'
              : 'UPDATED';
      }
      const dentition = (dto.dentition ??
        base?.dentition ??
        'PERMANENT') as Dentition;
      const data = base
        ? normalizeOdontogram(base.data, dentition)
        : emptyOdontogram();
      if (cur)
        await tx.clinicalOdontogram.update({
          where: { id: cur.id },
          data: { currentKey: null },
        });
      const created = await tx.clinicalOdontogram.create({
        data: {
          clinicId: d.clinicId,
          patientId,
          version: (cur?.version ?? 0) + 1,
          supersedesId: cur?.id ?? null,
          currentKey: patientId,
          status: 'DRAFT',
          dentition,
          data: data as unknown as Prisma.InputJsonValue,
          changeKind: kind,
          changeReason: dto.reason ?? null,
          createdById: actor.user.id,
        },
      });
      await this.record(
        tx,
        actor,
        d,
        meta,
        cur ? 'DRAFT_STARTED' : 'CREATED',
        created as Row,
        kind,
        ['data'],
      );
      return created as Row;
    });
    return { draft: presentOdontogram(row, true) };
  }

  /** Reemplaza el contenido del borrador en el sitio (solo quien lo abrió). Guardar lo mismo no cambia nada. */
  async saveDraft(
    actor: AuthPrincipal,
    patientId: string,
    dto: SaveOdontogramDraftDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['odontogram:save'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const row = await this.write(actor, d, patientId, meta, async (tx) => {
      const cur = await this.lockCurrent(tx, patientId, d.clinicId);
      if (!cur || cur.status !== 'DRAFT')
        throw new ConflictException({
          message: 'No hay un borrador abierto; abra uno para editar',
          code: 'NO_DRAFT',
        });
      if (cur.createdById !== actor.user.id) throw new DraftAuthorError();
      if (etagOf(cur) !== dto.expectedEtag) throw this.etagConflict(cur);
      const dentition = (dto.dentition ?? cur.dentition) as Dentition;
      const data = normalizeOdontogram(dto.data, dentition);
      if (
        dentition === cur.dentition &&
        JSON.stringify(data) ===
          JSON.stringify(normalizeOdontogram(cur.data, cur.dentition))
      )
        return cur;
      const updated = await tx.clinicalOdontogram.update({
        where: { id: cur.id },
        data: {
          data: data as unknown as Prisma.InputJsonValue,
          dentition,
          revision: { increment: 1 },
        },
      });
      await this.record(
        tx,
        actor,
        d,
        meta,
        'DRAFT_SAVED',
        updated as Row,
        cur.changeKind as Kind,
        ['data', ...(dentition !== cur.dentition ? ['dentition'] : [])],
      );
      return updated as Row;
    });
    return { draft: presentOdontogram(row, true) };
  }

  /** Guarda la versión: pasa a inmutable. Corregir o rectificar exige reautenticación (no es una firma). */
  async close(
    actor: AuthPrincipal,
    patientId: string,
    dto: CloseOdontogramDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['odontogram:close'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const peek = await this.db.clinicalOdontogram.findFirst({
      where: { patientId, clinicId: d.clinicId, currentKey: { not: null } },
      select: { status: true, changeKind: true },
    });
    if (!peek || peek.status !== 'DRAFT')
      throw new ConflictException({
        message: 'No hay un borrador para guardar',
        code: 'NO_DRAFT',
      });
    const needsReauth =
      peek.changeKind === 'CORRECTED' || peek.changeKind === 'RECTIFIED';
    const proofToken = needsReauth
      ? await this.reauth.proofFor(
          actor,
          dto,
          ReauthPurposeDto.CORRECT_ODONTOGRAM,
          patientId,
          meta,
        )
      : null;
    return this.finalize(
      actor,
      d,
      patientId,
      dto.expectedEtag,
      meta,
      async (tx, cur) => {
        if (cur.status !== 'DRAFT')
          throw new ConflictException({
            message: 'No hay un borrador para guardar',
            code: 'NO_DRAFT',
          });
        const data = normalizeOdontogram(cur.data, cur.dentition);
        const version = cur.version + 1;
        let proofId: string | null = null;
        if (proofToken)
          proofId = await this.consume(
            actor,
            proofToken,
            ReauthPurposeDto.CORRECT_ODONTOGRAM,
            patientId,
            meta,
            tx,
          );
        await tx.clinicalOdontogram.update({
          where: { id: cur.id },
          data: { currentKey: null },
        });
        const created = await tx.clinicalOdontogram.create({
          data: {
            clinicId: d.clinicId,
            patientId,
            version,
            supersedesId: cur.id,
            currentKey: patientId,
            status: 'CLOSED',
            dentition: cur.dentition,
            data: data as unknown as Prisma.InputJsonValue,
            changeKind: cur.changeKind as Kind,
            changeReason: cur.changeReason,
            contentHash: odontogramHash({
              patientId,
              version,
              dentition: cur.dentition,
              data,
            }),
            closedAt: new Date(),
            reauthProofId: proofId,
            createdById: actor.user.id,
          },
        });
        await this.record(
          tx,
          actor,
          d,
          meta,
          'CLOSED',
          created as Row,
          cur.changeKind as Kind,
          ['data'],
          needsReauth,
        );
        return created as Row;
      },
    ).then((row) => ({
      odontogram: presentOdontogram(row, true),
      reauth: {
        required: needsReauth,
        isSignature: false,
        notice: REAUTH_NOTICE,
      },
    }));
  }

  async discard(
    actor: AuthPrincipal,
    patientId: string,
    dto: DiscardOdontogramDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['odontogram:discard'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const row = await this.finalize(
      actor,
      d,
      patientId,
      dto.expectedEtag,
      meta,
      async (tx, cur) => {
        if (cur.status !== 'DRAFT')
          throw stateConflict('Solo se descarta un borrador');
        await tx.clinicalOdontogram.update({
          where: { id: cur.id },
          data: { currentKey: null },
        });
        const created = await tx.clinicalOdontogram.create({
          data: {
            clinicId: d.clinicId,
            patientId,
            version: cur.version + 1,
            supersedesId: cur.id,
            currentKey: patientId,
            status: 'DISCARDED',
            dentition: cur.dentition,
            data: cur.data as Prisma.InputJsonValue,
            changeKind: 'DISCARDED',
            changeReason: dto.reason,
            createdById: actor.user.id,
          },
        });
        await this.record(
          tx,
          actor,
          d,
          meta,
          'DISCARDED',
          created as Row,
          'DISCARDED',
          ['status'],
        );
        return created as Row;
      },
    );
    return { odontogram: presentOdontogram(row, true) };
  }

  /** Registra por error la versión guardada vigente (se conserva; vuelve a regir la anterior guardada). Exige reautenticación. */
  async markError(
    actor: AuthPrincipal,
    patientId: string,
    dto: MarkOdontogramErrorDto,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'write',
      ['odontogram:mark_error'],
      meta,
    );
    await requirePatient(this.db, d.clinicId, patientId, { active: true });
    const proofToken = await this.reauth.proofFor(
      actor,
      dto,
      ReauthPurposeDto.MARK_ODONTOGRAM_ERROR,
      patientId,
      meta,
    );
    const row = await this.finalize(
      actor,
      d,
      patientId,
      dto.expectedEtag,
      meta,
      async (tx, cur) => {
        if (cur.status !== 'CLOSED')
          throw stateConflict(
            'Solo se registra por error una versión guardada; descarte el borrador si lo hay',
          );
        const proofId = await this.consume(
          actor,
          proofToken,
          ReauthPurposeDto.MARK_ODONTOGRAM_ERROR,
          patientId,
          meta,
          tx,
        );
        await tx.clinicalOdontogram.update({
          where: { id: cur.id },
          data: { currentKey: null },
        });
        const created = await tx.clinicalOdontogram.create({
          data: {
            clinicId: d.clinicId,
            patientId,
            version: cur.version + 1,
            supersedesId: cur.id,
            currentKey: patientId,
            status: 'ENTERED_IN_ERROR',
            dentition: cur.dentition,
            data: cur.data as Prisma.InputJsonValue,
            changeKind: 'MARKED_IN_ERROR',
            changeReason: dto.reason,
            reauthProofId: proofId,
            createdById: actor.user.id,
          },
        });
        await this.record(
          tx,
          actor,
          d,
          meta,
          'MARKED_IN_ERROR',
          created as Row,
          'MARKED_IN_ERROR',
          ['status'],
          true,
        );
        return created as Row;
      },
    );
    return {
      odontogram: presentOdontogram(row, true),
      reauth: { required: true, isSignature: false, notice: REAUTH_NOTICE },
    };
  }

  // ----------------------------------------------------------------- exportar

  /** PDF (o SVG) de una versión GUARDADA, con identidad de la clínica y del paciente, fecha, profesional y el aviso de formato por validar. */
  async export(
    actor: AuthPrincipal,
    patientId: string,
    q: ExportOdontogramQuery,
    meta: RequestMeta,
  ) {
    const d = await this.access.authorize(
      actor,
      patientId,
      'read',
      ['odontogram_export'],
      meta,
      { allowLimited: false },
    );
    const rows = await this.chain(d.clinicId, patientId);
    const official = officialOf(rows);
    const errored = new Set(
      rows
        .filter((r) => r.status === 'ENTERED_IN_ERROR')
        .map((r) => r.supersedesId),
    );
    let target: { id: string } | undefined;
    if (q.version !== undefined) {
      const hit = rows.find((r) => r.version === q.version);
      if (!hit) throw recordNotFound();
      if (hit.status !== 'CLOSED' || errored.has(hit.id))
        throw stateConflict(
          'Solo se exporta una versión guardada que no esté registrada por error',
        );
      target = hit;
    } else target = official ?? undefined;
    if (!target)
      throw new NotFoundException(
        'Aún no hay una versión guardada para exportar',
      );
    const row = (await this.db.clinicalOdontogram.findUniqueOrThrow({
      where: { id: target.id },
    })) as Row;
    const format = q.format ?? 'pdf';

    // Auditoría PREVIA y estricta: si no se puede registrar la exportación, no se entrega el documento.
    try {
      await this.audit.record({
        action: 'CLINICAL_ODONTOGRAM_EXPORTED',
        entity: 'ClinicalOdontogram',
        entityId: patientId,
        patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: { version: row.version, format, via: d.via },
      });
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo registrar la exportación; por seguridad no se entregó el documento',
      );
    }

    const data = normalizeOdontogram(row.data, row.dentition);
    const stamp = (row.closedAt ?? row.createdAt).toISOString().slice(0, 10);
    if (format === 'svg') {
      const svg = renderOdontogramSvg(data, row.dentition, {
        title: `Odontograma · versión ${row.version}`,
        caption: `${FORMAT_NOTICE}`,
      });
      return {
        body: Buffer.from(svg, 'utf8'),
        type: 'image/svg+xml; charset=utf-8',
        filename: `odontograma-v${row.version}-${stamp}.svg`,
      };
    }
    const [clinic, patient, author] = await Promise.all([
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
        where: { id: row.createdById },
        select: { firstName: true, lastName: true },
      }),
    ]);
    const generatedBy = `${actor.user.firstName} ${actor.user.lastName}`;
    const state =
      row.changeKind === 'CORRECTED' || row.changeKind === 'RECTIFIED'
        ? 'CORRECTED'
        : 'CLOSED';
    const pdf = await renderOdontogramPdf({
      clinicName: clinic.brandDisplayName ?? clinic.name,
      patient: {
        fullName: fullName(patient),
        document: patient.identifiers[0]
          ? `${patient.identifiers[0].type} ${patient.identifiers[0].number}`
          : null,
        birthDate: formatDateOnly(patient.birthDate),
        age: patient.birthDate ? ageOn(patient.birthDate) : null,
      },
      version: {
        number: row.version,
        stateLabel: STATE_LABELS[state],
        kindLabel: KIND_LABELS[row.changeKind as keyof typeof KIND_LABELS],
        savedAt: row.closedAt ?? row.createdAt,
        author: `${author.firstName} ${author.lastName}`,
        hash: row.contentHash,
        reason: row.changeReason,
      },
      dentition: row.dentition,
      data,
      generatedAt: new Date(),
      generatedBy,
    });
    return {
      body: pdf,
      type: 'application/pdf',
      filename: `odontograma-v${row.version}-${stamp}.pdf`,
    };
  }

  // ------------------------------------------------------------------ internos

  /** Cadena resumida (sin el contenido) ordenada por versión. */
  private chain(clinicId: string, patientId: string) {
    return this.db.clinicalOdontogram.findMany({
      where: { clinicId, patientId },
      orderBy: { version: 'asc' },
      select: {
        id: true,
        version: true,
        revision: true,
        status: true,
        supersedesId: true,
        changeKind: true,
        createdById: true,
      },
    });
  }

  /** Transacción de escritura: relación revalidada bajo bloqueo compartido, bloqueo del paciente y negativas auditadas fuera de ella. */
  private async write<T>(
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    patientId: string,
    meta: RequestMeta,
    fn: (tx: DbTx) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await this.access.assertStillAuthorized(tx, actor, d, meta);
            await this.patientLock.lockPatient(tx, patientId); // serializa creación y cambios de la cadena del paciente
            return fn(tx);
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
    } catch (error) {
      if (error instanceof DraftAuthorError) {
        await this.access.denyBy(actor, patientId, meta, {
          reason: 'not_draft_author',
          code: 'NOT_DRAFT_AUTHOR',
          message:
            'El borrador lo abrió otro odontólogo; solo quien lo abrió puede modificarlo',
        });
      }
      if (isUniqueViolation(error))
        throw new ConflictException({
          message:
            'El odontograma cambió desde que lo abrió; vuelva a cargarlo',
          code: 'VERSION_CONFLICT',
        });
      throw error;
    }
  }

  /** Cierre/descarte/error sobre la versión vigente: etag, autor del borrador y reautenticación fallida auditada. */
  private async finalize(
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    patientId: string,
    expectedEtag: string,
    meta: RequestMeta,
    fn: (tx: DbTx, cur: Row) => Promise<Row>,
  ): Promise<Row> {
    try {
      return await this.write(actor, d, patientId, meta, async (tx) => {
        const cur = await this.lockCurrent(tx, patientId, d.clinicId);
        if (!cur) throw recordNotFound();
        if (etagOf(cur) !== expectedEtag) throw this.etagConflict(cur);
        if (cur.status === 'DRAFT' && cur.createdById !== actor.user.id)
          throw new DraftAuthorError();
        return fn(tx, cur);
      });
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

  private async consume(
    actor: AuthPrincipal,
    token: string,
    purpose: ReauthPurposeDto,
    patientId: string,
    meta: RequestMeta,
    tx: DbTx,
  ): Promise<string> {
    try {
      return await this.reauth.consume(
        { userId: actor.user.id, sessionId: actor.sessionId },
        token,
        purpose,
        patientId,
        meta,
        tx,
      );
    } catch (error) {
      if ((error as { status?: number }).status === 403)
        throw new ReauthFailed();
      throw error;
    }
  }

  /** Versión vigente de la cadena (bloqueada). Reintenta: si otra transacción la reemplazaba, al despertar toma la nueva. */
  private async lockCurrent(
    tx: DbTx,
    patientId: string,
    clinicId: string,
  ): Promise<Row | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM clinical_odontograms WHERE patient_id = ${patientId} AND clinic_id = ${clinicId} AND current_key IS NOT NULL FOR UPDATE`;
      if (locked[0])
        return (await tx.clinicalOdontogram.findUniqueOrThrow({
          where: { id: locked[0].id },
        })) as Row;
    }
    return null;
  }

  private etagConflict(cur: Row | null) {
    return new ConflictException({
      message:
        'El odontograma cambió desde que lo abrió; vuelva a cargarlo antes de guardar',
      code: 'VERSION_CONFLICT',
      currentEtag: cur ? etagOf(cur) : null,
    });
  }

  /** Referencias, versión y nombres de campos. NUNCA el contenido del odontograma ni el motivo. */
  private record(
    tx: DbTx,
    actor: AuthPrincipal,
    d: ClinicalAccessDecision,
    meta: RequestMeta,
    event: string,
    row: Row,
    kind: Kind,
    fields: string[],
    reauthenticated = false,
  ) {
    return this.audit.record(
      {
        action: `CLINICAL_ODONTOGRAM_${event}`,
        entity: 'ClinicalOdontogram',
        entityId: d.patientId,
        patientId: d.patientId,
        userId: actor.user.id,
        clinicId: d.clinicId,
        branchId: d.branchId,
        meta,
        summary: {
          version: row.version,
          revision: row.revision,
          changeKind: kind,
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
