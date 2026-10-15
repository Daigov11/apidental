import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { clinicScope, isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { BillingDeliveryService } from './billing-delivery.service.js';
import { DEMO_MARK, DOC_LABELS, docNumber, igvOf, KIND_LABELS, money, OUTBOX_LABELS, TYPE_LABELS } from './billing-format.js';
import type { EmitDocumentDto, ListDocumentsQuery, ListOutboxQuery } from './dto/integrations.dto.js';
import { simulationInfo } from './integrations.constants.js';
import { enqueueOutbox, OutboxService } from './outbox.service.js';
import { SCENARIO_LABELS, type BillingScenario } from './providers/mock/mock-billing.provider.js';
import { renderDocumentPdf } from './document-pdf.js';

type DocRow = {
  id: string; chargeId: string; type: 'BOLETA' | 'FACTURA'; series: string; number: number; status: keyof typeof DOC_LABELS; customerName: string; customerDocType: string;
  customerDocNumber: string; amountCents: number; igvCents: number; demoMark: string; providerRef: string | null; rejectionReason: string | null; scenario: string | null;
  attempts: number; lastAttemptAt: Date | null; issuedAt: Date | null; createdAt: Date;
};

export function presentDocument(d: DocRow) {
  return {
    id: d.id,
    chargeId: d.chargeId,
    type: d.type,
    typeLabel: TYPE_LABELS[d.type],
    number: docNumber(d.series, d.number),
    status: d.status,
    statusLabel: DOC_LABELS[d.status],
    customer: { name: d.customerName, docType: d.customerDocType, docNumber: d.customerDocNumber },
    amountCents: d.amountCents,
    amountText: money(d.amountCents),
    igvText: money(d.igvCents),
    subtotalText: money(d.amountCents - d.igvCents),
    /// Marca visible obligatoria de todo comprobante simulado.
    demoMark: d.demoMark,
    simulated: true,
    providerRef: d.providerRef,
    rejectionReason: d.rejectionReason,
    scenario: d.scenario,
    scenarioLabel: d.scenario ? SCENARIO_LABELS[d.scenario as BillingScenario] ?? null : null,
    attempts: d.attempts,
    lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
    issuedAt: d.issuedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    actions: {
      retry: d.status === 'RETRYABLE_ERROR',
      reconcile: d.status === 'SENT' || d.status === 'NEEDS_RECONCILIATION' || d.status === 'RETRYABLE_ERROR',
      pdf: true,
    },
  };
}

const SERIES = { BOLETA: 'BD01', FACTURA: 'FD01' } as const;

/**
 * Comprobantes SIMULADOS: se encolan (outbox) y los entrega un procesador al proveedor, con la misma clave de
 * idempotencia siempre. Estados locales: pendiente de envío, enviado, emitido, rechazado, error reintentable y requiere
 * conciliación. Todo comprobante lleva «DEMO — NO VÁLIDO PARA SUNAT» (la base de datos lo exige). Un comprobante
 * rechazado no se corrige: se emite otro nuevo con otro número.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly delivery: BillingDeliveryService,
  ) {}

  private async loadDoc(actor: AuthPrincipal, id: string) {
    const { clinicId, branchId } = clinicScope(actor);
    const d = await this.db.billingDocument.findFirst({ where: { id, clinicId }, include: { charge: { select: { branchId: true, description: true, patientId: true } } } });
    if (!d || (branchId && d.charge.branchId !== branchId)) throw new NotFoundException('Comprobante no encontrado');
    return d;
  }

  async emit(actor: AuthPrincipal, chargeId: string, dto: EmitDocumentDto, meta: RequestMeta) {
    const { clinicId, branchId: ctxBranch } = clinicScope(actor);
    if (dto.type === 'FACTURA' && (!dto.customerRuc || !dto.customerName)) throw new BadRequestException('Para una factura indique el RUC y la razón social del cliente');
    const charge = await this.db.charge.findFirst({ where: { id: chargeId, clinicId }, include: { patient: true } });
    if (!charge || (ctxBranch && charge.branchId !== ctxBranch)) throw new NotFoundException('Cobro no encontrado');
    if (charge.status !== 'PAID') throw new ConflictException({ message: 'Solo se emite comprobante de un cobro pagado', code: 'CHARGE_NOT_PAID' });
    let customer: { docType: string; docNumber: string; name: string };
    if (dto.type === 'FACTURA') customer = { docType: 'RUC', docNumber: dto.customerRuc!, name: dto.customerName! };
    else {
      const ids = await this.db.patientIdentifier.findMany({ where: { patientId: charge.patientId, clinicId, status: 'ACTIVE' }, select: { type: true, number: true } });
      const id = ids.find((i) => i.type === 'DNI') ?? ids[0];
      customer = { docType: id?.type ?? 'SIN_DOC', docNumber: id?.number ?? '-', name: [charge.patient.firstName, charge.patient.lastName, charge.patient.secondLastName].filter(Boolean).join(' ') };
    }
    try {
      const { doc, item } = await withTxRetry(() =>
        this.db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM charges WHERE id = ${chargeId} FOR UPDATE`;
            const previous = await tx.billingDocument.findMany({ where: { chargeId }, select: { status: true, id: true } });
            const active = previous.find((p) => p.status !== 'REJECTED');
            if (active) throw new ConflictException({ message: 'El cobro ya tiene un comprobante vigente', code: 'DOCUMENT_EXISTS' });
            const series = SERIES[dto.type];
            await tx.$executeRaw`INSERT IGNORE INTO billing_counters (clinic_id, series, last) VALUES (${clinicId}, ${series}, 0)`;
            await tx.$queryRaw`SELECT last FROM billing_counters WHERE clinic_id = ${clinicId} AND series = ${series} FOR UPDATE`;
            await tx.$executeRaw`UPDATE billing_counters SET last = last + 1 WHERE clinic_id = ${clinicId} AND series = ${series}`;
            const counter = await tx.$queryRaw<{ last: number }[]>`SELECT last FROM billing_counters WHERE clinic_id = ${clinicId} AND series = ${series}`;
            const last = Number(counter[0]!.last);
            const key = `doc:${chargeId}:${previous.length + 1}`;
            const created = await tx.billingDocument.create({
              data: {
                clinicId, chargeId, type: dto.type, series, number: last, customerName: customer.name, customerDocType: customer.docType, customerDocNumber: customer.docNumber,
                amountCents: charge.amountCents, igvCents: igvOf(charge.amountCents), demoMark: DEMO_MARK, idempotencyKey: key, activeKey: chargeId,
                scenario: dto.scenario ?? 'ISSUE', createdById: actor.user.id,
              },
            });
            const queued = await enqueueOutbox(tx, { clinicId, kind: 'BILLING_EMIT', aggregateType: 'BillingDocument', aggregateId: created.id, idempotencyKey: `emit:${key}` });
            await this.audit.record({ action: 'DOCUMENT_QUEUED', entity: 'BillingDocument', entityId: created.id, patientId: charge.patientId, userId: actor.user.id, clinicId, branchId: charge.branchId, meta, summary: { type: dto.type, number: docNumber(series, last), scenario: created.scenario, simulated: true } }, tx);
            return { doc: created, item: queued };
          },
          { isolationLevel: 'ReadCommitted' },
        ),
      );
      // Entrega inmediata (el cliente ve el resultado); si falla, la cola la reintenta.
      await this.outbox.processOne(item.id, true);
      return this.get(actor, doc.id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ message: 'El cobro ya tiene un comprobante vigente', code: 'DOCUMENT_EXISTS' });
      throw e;
    }
  }

  async get(actor: AuthPrincipal, id: string) {
    return presentDocument(await this.loadDoc(actor, id));
  }

  async list(actor: AuthPrincipal, q: ListDocumentsQuery) {
    const { clinicId, branchId } = clinicScope(actor);
    const rows = await this.db.billingDocument.findMany({
      where: { clinicId, ...(q.status ? { status: q.status } : {}), ...(q.chargeId ? { chargeId: q.chargeId } : {}), ...(branchId ? { charge: { branchId } } : {}) },
      include: { charge: { select: { description: true, patient: { select: { firstName: true, lastName: true } } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: q.limit, skip: q.offset,
    });
    return rows.map((r) => ({ ...presentDocument(r), description: r.charge.description, patientName: `${r.charge.patient.firstName} ${r.charge.patient.lastName}` }));
  }

  /** Reintento manual de un error reintentable: misma clave de idempotencia, sin esperar el tiempo de espera. */
  async retry(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    const d = await this.loadDoc(actor, id);
    if (d.status !== 'RETRYABLE_ERROR') throw new ConflictException({ message: 'Solo se reintenta un comprobante con error reintentable', code: 'INVALID_TRANSITION' });
    const item = await this.db.integrationOutbox.findUniqueOrThrow({ where: { idempotencyKey: `emit:${d.idempotencyKey}` } });
    await this.db.integrationOutbox.update({ where: { id: item.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), note: 'Reintento manual' } });
    await this.audit.record({ action: 'DOCUMENT_RETRY_REQUESTED', entity: 'BillingDocument', entityId: id, userId: actor.user.id, clinicId: d.clinicId, meta, summary: { simulated: true } });
    await this.outbox.processOne(item.id, true);
    return this.get(actor, id);
  }

  async reconcile(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    const d = await this.loadDoc(actor, id);
    if (!['SENT', 'NEEDS_RECONCILIATION', 'RETRYABLE_ERROR'].includes(d.status)) throw new ConflictException({ message: 'Este comprobante no necesita conciliación', code: 'INVALID_TRANSITION' });
    const result = await this.delivery.reconcile(id);
    await this.audit.record({ action: 'DOCUMENT_RECONCILE_REQUESTED', entity: 'BillingDocument', entityId: id, userId: actor.user.id, clinicId: d.clinicId, meta, summary: { result, simulated: true } });
    if (result === 'REQUEUED') {
      const item = await this.db.integrationOutbox.findUnique({ where: { idempotencyKey: `emit:${d.idempotencyKey}` } });
      if (item) await this.outbox.processOne(item.id, true);
    }
    return this.get(actor, id);
  }

  /** Concilia todos los comprobantes dudosos de la clínica. */
  async reconcileAll(actor: AuthPrincipal, meta: RequestMeta) {
    const { clinicId } = clinicScope(actor);
    const docs = await this.db.billingDocument.findMany({ where: { clinicId, status: { in: ['SENT', 'NEEDS_RECONCILIATION'] } }, select: { id: true }, take: 100 });
    const counts: Record<string, number> = {};
    for (const { id } of docs) {
      const r = await this.delivery.reconcile(id);
      counts[r] = (counts[r] ?? 0) + 1;
    }
    await this.audit.record({ action: 'DOCUMENT_RECONCILE_ALL', entity: 'Clinic', entityId: clinicId, userId: actor.user.id, clinicId, meta, summary: { checked: docs.length, ...counts, simulated: true } });
    const pending = await this.outbox.processDue(clinicId);
    return { checked: docs.length, results: counts, queue: pending };
  }

  async pdf(actor: AuthPrincipal, id: string, meta: RequestMeta) {
    const d = await this.loadDoc(actor, id);
    const clinic = await this.db.clinic.findUniqueOrThrow({ where: { id: d.clinicId }, select: { name: true } });
    await this.audit.record({ action: 'DOCUMENT_PDF_DOWNLOADED', entity: 'BillingDocument', entityId: id, userId: actor.user.id, clinicId: d.clinicId, meta, summary: { simulated: true } });
    const v = presentDocument(d);
    const body = await renderDocumentPdf({ clinicName: clinic.name, doc: v, concept: d.charge.description, createdAt: d.createdAt });
    return { body, filename: `comprobante-demo-${v.number}.pdf` };
  }

  // ------------------------------------------------------------------- cola
  async outboxList(actor: AuthPrincipal, q: ListOutboxQuery) {
    const { clinicId } = clinicScope(actor);
    const rows = await this.db.integrationOutbox.findMany({ where: { clinicId, ...(q.status ? { status: q.status } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: q.limit, skip: q.offset });
    const docs = await this.db.billingDocument.findMany({ where: { id: { in: rows.filter((r) => r.kind === 'BILLING_EMIT').map((r) => r.aggregateId) } }, select: { id: true, series: true, number: true } });
    const charges = await this.db.charge.findMany({ where: { id: { in: rows.filter((r) => r.kind !== 'BILLING_EMIT').map((r) => r.aggregateId) } }, select: { id: true, description: true } });
    return rows.map((r) => ({
      id: r.id, kind: r.kind, kindLabel: KIND_LABELS[r.kind], status: r.status, statusLabel: OUTBOX_LABELS[r.status], attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt.toISOString(), note: r.note, createdAt: r.createdAt.toISOString(), processedAt: r.processedAt?.toISOString() ?? null,
      reference: r.kind === 'BILLING_EMIT' ? (docs.find((d) => d.id === r.aggregateId) ? docNumber(docs.find((d) => d.id === r.aggregateId)!.series, docs.find((d) => d.id === r.aggregateId)!.number) : '') : (charges.find((c) => c.id === r.aggregateId)?.description ?? ''),
    }));
  }

  async outboxProcess(actor: AuthPrincipal, meta: RequestMeta) {
    const { clinicId } = clinicScope(actor);
    const r = await this.outbox.processDue(clinicId);
    await this.audit.record({ action: 'OUTBOX_PROCESSED', entity: 'Clinic', entityId: clinicId, userId: actor.user.id, clinicId, meta, summary: { ...r, simulated: true } });
    return r;
  }

  status(mode: string) {
    return { mode, simulation: mode === 'mock' ? simulationInfo() : null, scenarios: Object.entries(SCENARIO_LABELS).map(([code, label]) => ({ code, label })) };
  }
}
