import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaDb } from '../../../prisma/client.js';
import { PRISMA } from '../../../prisma/prisma.module.js';
import { isUniqueViolation } from '../../../patients/patient-access.js';
import {
  type BillingEmitRequest, type BillingEmitResult, type BillingProvider, type BillingStatusResult, ProviderTimeoutError, ProviderTransientError,
} from '../billing-provider.js';

export const BILLING_SCENARIOS = ['ISSUE', 'PENDING', 'REJECT', 'ERROR_THEN_OK', 'TIMEOUT'] as const;
export type BillingScenario = (typeof BILLING_SCENARIOS)[number];
export const SCENARIO_LABELS: Record<BillingScenario, string> = {
  ISSUE: 'Emitido de inmediato',
  PENDING: 'Queda pendiente de confirmación',
  REJECT: 'Rechazado',
  ERROR_THEN_OK: 'Falla una vez y luego se emite (reintento)',
  TIMEOUT: 'No responde a tiempo (requiere conciliación)',
};

interface Stored { providerRef?: string; issuedAt?: string; reason?: string }

/**
 * SIMULADOR del proveedor de comprobantes. No usa credenciales ni endpoints reales y NO emite nada ante SUNAT.
 * Se comporta como un proveedor real en lo que importa para la integración: recuerda las solicitudes por clave de
 * idempotencia (reenviar no duplica), puede quedar pendiente, rechazar, fallar de forma temporal o no responder a
 * tiempo habiendo procesado la solicitud (para practicar la conciliación). Los textos de rechazo son ficticios.
 */
@Injectable()
export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock-billing';
  readonly simulated = true;
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  private ref(key: string): string {
    return `DEMO-${createHash('sha256').update(key).digest('hex').slice(0, 10).toUpperCase()}`;
  }

  private fromRecord(state: string, result: Stored | null): BillingEmitResult | null {
    if (state === 'ISSUED') return { status: 'ISSUED', providerRef: result?.providerRef ?? '', issuedAt: new Date(result?.issuedAt ?? Date.now()) };
    if (state === 'REJECTED') return { status: 'REJECTED', reason: result?.reason ?? 'Rechazo simulado' };
    if (state === 'PENDING') return { status: 'PENDING', providerRef: result?.providerRef };
    return null;
  }

  private async store(key: string, state: string, attempts: number, result: Stored | null, create: boolean): Promise<void> {
    const data = { state, attempts, result: (result ?? undefined) as never };
    if (create) {
      try {
        await this.db.mockProviderRecord.create({ data: { idempotencyKey: key, kind: 'BILLING', ...data } });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // otra solicitud con la misma clave ganó: se respetará su registro
      }
    } else await this.db.mockProviderRecord.update({ where: { idempotencyKey: key }, data });
  }

  async emit(req: BillingEmitRequest): Promise<BillingEmitResult> {
    const existing = await this.db.mockProviderRecord.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
    const known = existing ? this.fromRecord(existing.state, existing.result as Stored | null) : null;
    if (known) return known; // idempotencia: misma clave, misma respuesta
    const scenario = (BILLING_SCENARIOS as readonly string[]).includes(req.scenario ?? '') ? (req.scenario as BillingScenario) : 'ISSUE';
    const providerRef = this.ref(req.idempotencyKey);
    const issued: Stored = { providerRef, issuedAt: new Date().toISOString() };

    if (scenario === 'ERROR_THEN_OK') {
      const attempts = (existing?.attempts ?? 0) + 1;
      if (attempts === 1) {
        await this.store(req.idempotencyKey, 'TRANSIENT', attempts, null, !existing);
        throw new ProviderTransientError('Servicio no disponible (simulado)');
      }
      await this.store(req.idempotencyKey, 'ISSUED', attempts, issued, !existing);
      return { status: 'ISSUED', providerRef, issuedAt: new Date(issued.issuedAt!) };
    }
    if (scenario === 'TIMEOUT') {
      // El proveedor procesa la solicitud pero la respuesta no llega: el sistema local no sabe qué pasó.
      await this.store(req.idempotencyKey, 'ISSUED', 1, issued, !existing);
      throw new ProviderTimeoutError('Tiempo de espera agotado (simulado)');
    }
    if (scenario === 'REJECT') {
      const reason = 'Rechazo simulado: el dato del cliente no pasó la validación de demostración.';
      await this.store(req.idempotencyKey, 'REJECTED', 1, { reason }, !existing);
      return { status: 'REJECTED', reason };
    }
    if (scenario === 'PENDING') {
      await this.store(req.idempotencyKey, 'PENDING', 1, { providerRef }, !existing);
      return { status: 'PENDING', providerRef };
    }
    await this.store(req.idempotencyKey, 'ISSUED', 1, issued, !existing);
    return { status: 'ISSUED', providerRef, issuedAt: new Date(issued.issuedAt!) };
  }

  async getStatus(idempotencyKey: string): Promise<BillingStatusResult> {
    const rec = await this.db.mockProviderRecord.findUnique({ where: { idempotencyKey } });
    if (!rec || rec.state === 'TRANSIENT') return { found: false };
    const stored = rec.result as Stored | null;
    if (rec.state === 'PENDING') {
      // El simulador «confirma» una solicitud pendiente la primera vez que se le consulta.
      const result: Stored = { providerRef: stored?.providerRef ?? this.ref(idempotencyKey), issuedAt: new Date().toISOString() };
      await this.store(idempotencyKey, 'ISSUED', rec.attempts, result, false);
      return { found: true, status: 'ISSUED', providerRef: result.providerRef, issuedAt: new Date(result.issuedAt!) };
    }
    if (rec.state === 'REJECTED') return { found: true, status: 'REJECTED', reason: stored?.reason };
    return { found: true, status: 'ISSUED', providerRef: stored?.providerRef, issuedAt: stored?.issuedAt ? new Date(stored.issuedAt) : undefined };
  }
}
