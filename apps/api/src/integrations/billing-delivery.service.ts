import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { BILLING_PROVIDER } from './integrations.constants.js';
import { type BillingProvider, ProviderTimeoutError, ProviderTransientError } from './providers/billing-provider.js';

type DeliveryOutcome = { status: 'DONE' | 'RETRY'; note?: string };
const OPEN = ['PENDING_SEND', 'RETRYABLE_ERROR'] as const;
const UNSETTLED = ['PENDING_SEND', 'SENT', 'RETRYABLE_ERROR', 'NEEDS_RECONCILIATION'] as const;

/** Entrega de un comprobante al proveedor y conciliación con él. Todas las transiciones son condicionales (sin carreras). */
@Injectable()
export class BillingDeliveryService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  private note(docId: string, clinicId: string, action: string, summary: Record<string, unknown>) {
    return this.audit.record({ action, entity: 'BillingDocument', entityId: docId, userId: null, clinicId, summary: { ...summary, simulated: true } });
  }

  async deliver(docId: string): Promise<DeliveryOutcome> {
    const doc = await this.db.billingDocument.findUnique({ where: { id: docId }, include: { charge: { select: { description: true } } } });
    if (!doc) return { status: 'DONE', note: 'El comprobante ya no existe' };
    if (!(OPEN as readonly string[]).includes(doc.status)) return { status: 'DONE', note: 'Ya estaba procesado' };
    const attempt = doc.attempts + 1;
    await this.db.billingDocument.updateMany({ where: { id: docId, status: { in: [...OPEN] } }, data: { attempts: attempt, lastAttemptAt: new Date() } });
    try {
      const r = await this.provider.emit({
        idempotencyKey: doc.idempotencyKey, clinicId: doc.clinicId, type: doc.type, series: doc.series, number: doc.number,
        customer: { docType: doc.customerDocType, docNumber: doc.customerDocNumber, name: doc.customerName },
        amountCents: doc.amountCents, igvCents: doc.igvCents, currency: 'PEN', description: doc.charge.description, attempt, scenario: doc.scenario,
      });
      if (r.status === 'ISSUED') {
        await this.db.billingDocument.updateMany({ where: { id: docId, status: { in: [...OPEN] } }, data: { status: 'ISSUED', providerRef: r.providerRef, issuedAt: r.issuedAt } });
        await this.note(docId, doc.clinicId, 'DOCUMENT_ISSUED', { attempt });
        return { status: 'DONE', note: 'Emitido (simulado)' };
      }
      if (r.status === 'PENDING') {
        await this.db.billingDocument.updateMany({ where: { id: docId, status: { in: [...OPEN] } }, data: { status: 'SENT', providerRef: r.providerRef ?? null } });
        await this.note(docId, doc.clinicId, 'DOCUMENT_SENT', { attempt });
        return { status: 'DONE', note: 'Enviado; falta la confirmación (concilie)' };
      }
      await this.db.billingDocument.updateMany({ where: { id: docId, status: { in: [...OPEN] } }, data: { status: 'REJECTED', rejectionReason: r.reason, activeKey: null } });
      await this.note(docId, doc.clinicId, 'DOCUMENT_REJECTED', { attempt });
      return { status: 'DONE', note: 'Rechazado (simulado)' };
    } catch (e) {
      if (e instanceof ProviderTimeoutError) {
        await this.db.billingDocument.updateMany({ where: { id: docId, status: { in: [...OPEN] } }, data: { status: 'NEEDS_RECONCILIATION' } });
        await this.note(docId, doc.clinicId, 'DOCUMENT_NEEDS_RECONCILIATION', { attempt });
        return { status: 'DONE', note: 'Sin respuesta a tiempo; requiere conciliación' };
      }
      await this.db.billingDocument.updateMany({ where: { id: docId, status: { in: [...OPEN] } }, data: { status: 'RETRYABLE_ERROR' } });
      await this.note(docId, doc.clinicId, 'DOCUMENT_RETRYABLE_ERROR', { attempt });
      return { status: 'RETRY', note: e instanceof ProviderTransientError ? 'Servicio no disponible (simulado)' : 'Error inesperado' };
    }
  }

  /**
   * Conciliación: pregunta al proveedor por la clave de idempotencia y alinea el estado local. Si el proveedor nunca
   * recibió la solicitud, devuelve el comprobante a «pendiente de envío» (reenviar es seguro: misma clave).
   */
  async reconcile(docId: string): Promise<'ISSUED' | 'REJECTED' | 'SENT' | 'REQUEUED' | 'UNCHANGED'> {
    const doc = await this.db.billingDocument.findUnique({ where: { id: docId } });
    if (!doc || !(UNSETTLED as readonly string[]).includes(doc.status) || doc.status === 'PENDING_SEND') return 'UNCHANGED';
    const r = await this.provider.getStatus(doc.idempotencyKey);
    const from = { id: docId, status: { in: [...UNSETTLED] } };
    if (!r.found) {
      // Al reenviar, la falla simulada ya pasó: el simulador responde con normalidad.
      await this.db.billingDocument.updateMany({ where: from, data: { status: 'PENDING_SEND', scenario: 'ISSUE' } });
      await this.db.integrationOutbox.updateMany({ where: { idempotencyKey: `emit:${doc.idempotencyKey}` }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), note: 'Reencolado tras conciliar' } });
      await this.note(docId, doc.clinicId, 'DOCUMENT_RECONCILED', { result: 'requeued' });
      return 'REQUEUED';
    }
    if (r.status === 'ISSUED') {
      await this.db.billingDocument.updateMany({ where: from, data: { status: 'ISSUED', providerRef: r.providerRef ?? doc.providerRef ?? 'DEMO-SIN-REF', issuedAt: r.issuedAt ?? new Date() } });
      await this.note(docId, doc.clinicId, 'DOCUMENT_RECONCILED', { result: 'issued' });
      return 'ISSUED';
    }
    if (r.status === 'REJECTED') {
      await this.db.billingDocument.updateMany({ where: from, data: { status: 'REJECTED', rejectionReason: r.reason ?? 'Rechazo simulado', activeKey: null } });
      await this.note(docId, doc.clinicId, 'DOCUMENT_RECONCILED', { result: 'rejected' });
      return 'REJECTED';
    }
    await this.db.billingDocument.updateMany({ where: from, data: { status: 'SENT' } });
    return 'SENT';
  }
}
