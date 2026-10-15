import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { clinicScope, requirePatient } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { RedeemDto } from './dto/integrations.dto.js';
import { LOYALTY_PROVIDER, REVIEW_PROVIDER, simulationInfo } from './integrations.constants.js';
import { InsufficientPointsError, type LoyaltyProvider } from './providers/loyalty-provider.js';
import type { ReviewProvider } from './providers/review-provider.js';

/**
 * Fidelización y reseñas SIMULADAS. Se consulta el proveedor solo si el paciente autorizó la fidelización (consentimiento
 * LOYALTY vigente); sin autorización no se envía ni se muestra nada. Toda respuesta declara que es una simulación.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    @Inject(LOYALTY_PROVIDER) private readonly loyalty: LoyaltyProvider,
    @Inject(REVIEW_PROVIDER) private readonly reviews: ReviewProvider,
  ) {}

  private async hasConsent(clinicId: string, patientId: string): Promise<boolean> {
    return Boolean(await this.db.patientConsent.findUnique({ where: { activeKey: `${patientId}|LOYALTY` }, select: { id: true } }));
  }

  async summary(actor: AuthPrincipal, patientId: string) {
    const { clinicId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    if (!(await this.hasConsent(clinicId, patientId))) {
      return { simulation: simulationInfo(), consent: 'MISSING' as const, message: 'El paciente no ha autorizado el programa de fidelización; no se muestran ni se acumulan puntos.' };
    }
    const [points, nfc] = await Promise.all([this.loyalty.summary({ clinicId, patientRef: patientId }), this.loyalty.nfcSummary({ clinicId, patientRef: patientId })]);
    return {
      simulation: simulationInfo(),
      consent: 'GRANTED' as const,
      points: { balance: points.balance, accrued: points.accrued, redeemed: points.redeemed, tier: points.tier, recent: points.recent.map((r) => ({ kind: r.kind, kindLabel: r.kind === 'ACCRUAL' ? 'Acumulación' : 'Canje', points: r.points, reason: r.reason, at: r.at.toISOString() })) },
      nfc: { cardLabel: nfc.cardLabel, status: nfc.status, tapsLast30Days: nfc.tapsLast30Days, lastTapAt: nfc.lastTapAt?.toISOString() ?? null, tier: nfc.tier },
      rule: '1 punto por cada S/ 10 pagados (regla ficticia de demostración).',
    };
  }

  async redeem(actor: AuthPrincipal, patientId: string, dto: RedeemDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });
    if (!(await this.hasConsent(clinicId, patientId))) throw new ConflictException({ message: 'El paciente no ha autorizado el programa de fidelización', code: 'NO_LOYALTY_CONSENT' });
    try {
      const r = await this.loyalty.redeem({ clinicId, patientRef: patientId, points: dto.points, idempotencyKey: `redeem:${dto.requestId ?? randomUUID()}`, reason: dto.reason || 'Canje en caja (simulado)' });
      await this.audit.record({ action: 'LOYALTY_REDEEMED', entity: 'Patient', entityId: patientId, patientId, userId: actor.user.id, clinicId, branchId, meta, summary: { points: dto.points, balance: r.balance, simulated: true } });
      return { simulation: simulationInfo(), balance: r.balance, redeemed: dto.points };
    } catch (e) {
      if (e instanceof InsufficientPointsError) throw new ConflictException({ message: 'El paciente no tiene puntos suficientes', code: 'INSUFFICIENT_POINTS' });
      throw e;
    }
  }

  async reviewSummary(actor: AuthPrincipal) {
    const { clinicId } = clinicScope(actor);
    const s = await this.reviews.summary({ clinicId });
    const queued = await this.db.integrationOutbox.count({ where: { clinicId, kind: 'REVIEW_REQUEST', status: 'PENDING' } });
    return { simulation: simulationInfo(), ...s, queued };
  }
}
