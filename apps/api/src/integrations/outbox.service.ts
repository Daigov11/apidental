import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppConfig } from '../config/app-config.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { BillingDeliveryService } from './billing-delivery.service.js';
import { POINTS_PER_CENTS, LOYALTY_PROVIDER, REVIEW_PROVIDER } from './integrations.constants.js';
import { ProviderTransientError } from './providers/billing-provider.js';
import type { LoyaltyProvider } from './providers/loyalty-provider.js';
import type { ReviewProvider } from './providers/review-provider.js';

export type OutboxKindCode = 'BILLING_EMIT' | 'LOYALTY_ACCRUE' | 'REVIEW_REQUEST';
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 600_000);

/** Encola un mensaje en la MISMA transacción que el cambio local (patrón outbox). La clave evita duplicados. */
export async function enqueueOutbox(tx: DbTx, m: { clinicId: string; kind: OutboxKindCode; aggregateType: string; aggregateId: string; idempotencyKey: string }) {
  const existing = await tx.integrationOutbox.findUnique({ where: { idempotencyKey: m.idempotencyKey } });
  if (existing) return existing;
  return tx.integrationOutbox.create({ data: m });
}

interface Outcome { status: 'DONE' | 'SKIPPED' | 'RETRY'; note?: string }

/**
 * Cola de integraciones: entrega comprobantes, puntos y solicitudes de reseña al proveedor (simulado). Cada mensaje se
 * reclama con un arrendamiento corto (nunca dos procesadores a la vez), se reintenta con espera creciente y pasa a
 * FALLÓ tras 5 intentos. Es idempotente: el proveedor recibe siempre la misma clave del mensaje.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('IntegrationsOutbox');
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly delivery: BillingDeliveryService,
    @Inject(LOYALTY_PROVIDER) private readonly loyalty: LoyaltyProvider,
    @Inject(REVIEW_PROVIDER) private readonly reviews: ReviewProvider,
  ) {}

  onModuleInit() {
    const ms = this.config.integrations.workerIntervalMs;
    if (this.config.integrations.mode === 'mock' && ms > 0) {
      this.timer = setInterval(() => void this.processDue().catch((e: unknown) => this.logger.error(`Procesador: ${e instanceof Error ? e.message : 'error'}`)), ms);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Procesa los mensajes vencidos (opcionalmente de una sola clínica). */
  async processDue(clinicId?: string, limit = 25): Promise<{ processed: number; done: number; retry: number; skipped: number; failed: number }> {
    const due = await this.db.integrationOutbox.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() }, ...(clinicId ? { clinicId } : {}) },
      orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
    });
    const total = { processed: 0, done: 0, retry: 0, skipped: 0, failed: 0 };
    for (const { id } of due) {
      const r = await this.processOne(id);
      if (!r) continue;
      total.processed++;
      if (r === 'DONE') total.done++; else if (r === 'SKIPPED') total.skipped++; else if (r === 'FAILED') total.failed++; else total.retry++;
    }
    return total;
  }

  /** Procesa un mensaje. `force` ignora la espera programada (acción manual de reintento). */
  async processOne(id: string, force = false): Promise<'DONE' | 'SKIPPED' | 'FAILED' | 'RETRY' | null> {
    const now = new Date();
    const claimed = await this.db.integrationOutbox.updateMany({
      where: { id, status: 'PENDING', ...(force ? {} : { nextAttemptAt: { lte: now } }) },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count !== 1) return null; // otro procesador lo tiene o ya terminó
    const item = await this.db.integrationOutbox.findUniqueOrThrow({ where: { id } });
    let outcome: Outcome;
    try {
      outcome = await this.dispatch(item);
    } catch (e) {
      outcome = { status: 'RETRY', note: e instanceof ProviderTransientError ? 'Servicio no disponible (simulado); se reintentará' : 'Error inesperado; se reintentará' };
    }
    if (outcome.status === 'RETRY') {
      const failed = item.attempts >= MAX_ATTEMPTS;
      await this.db.integrationOutbox.update({
        where: { id },
        data: failed ? { status: 'FAILED', note: outcome.note ?? null, processedAt: new Date() } : { nextAttemptAt: new Date(Date.now() + backoffMs(item.attempts)), note: outcome.note ?? null },
      });
      return failed ? 'FAILED' : 'RETRY';
    }
    await this.db.integrationOutbox.update({ where: { id }, data: { status: outcome.status, note: outcome.note ?? null, processedAt: new Date() } });
    return outcome.status;
  }

  private async dispatch(item: { id: string; kind: string; aggregateId: string; clinicId: string; idempotencyKey: string }): Promise<Outcome> {
    if (item.kind === 'BILLING_EMIT') return this.delivery.deliver(item.aggregateId);
    const charge = await this.db.charge.findFirst({ where: { id: item.aggregateId, clinicId: item.clinicId } });
    if (!charge || charge.status !== 'PAID') return { status: 'SKIPPED', note: 'El cobro ya no está pagado' };
    const consentType = item.kind === 'LOYALTY_ACCRUE' ? 'LOYALTY' : 'MARKETING';
    const consent = await this.db.patientConsent.findUnique({ where: { activeKey: `${charge.patientId}|${consentType}` }, select: { id: true } });
    if (!consent) return { status: 'SKIPPED', note: `Sin autorización de ${consentType === 'LOYALTY' ? 'fidelización' : 'comunicaciones (marketing)'} del paciente` };
    if (item.kind === 'LOYALTY_ACCRUE') {
      const points = Math.floor(charge.amountCents / POINTS_PER_CENTS);
      if (points < 1) return { status: 'SKIPPED', note: 'El monto no alcanza para puntos' };
      const r = await this.loyalty.accrue({ clinicId: charge.clinicId, patientRef: charge.patientId, points, idempotencyKey: item.idempotencyKey, reason: 'Pago de atención (simulado)' });
      await this.audit.record({ action: 'LOYALTY_ACCRUED', entity: 'Charge', entityId: charge.id, patientId: charge.patientId, userId: null, clinicId: charge.clinicId, branchId: charge.branchId, summary: { points, balance: r.balance, simulated: true } });
      return { status: 'DONE', note: `+${points} puntos (simulado)` };
    }
    const r = await this.reviews.requestReview({ clinicId: charge.clinicId, patientRef: charge.patientId, idempotencyKey: item.idempotencyKey });
    await this.audit.record({ action: 'REVIEW_REQUESTED', entity: 'Charge', entityId: charge.id, patientId: charge.patientId, userId: null, clinicId: charge.clinicId, branchId: charge.branchId, summary: { requestId: r.requestId, simulated: true } });
    return { status: 'DONE', note: r.status };
  }
}
