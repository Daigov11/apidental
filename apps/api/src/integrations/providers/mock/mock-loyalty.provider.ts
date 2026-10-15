import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaDb } from '../../../prisma/client.js';
import { PRISMA } from '../../../prisma/prisma.module.js';
import { isUniqueViolation } from '../../../patients/patient-access.js';
import { InsufficientPointsError, type LoyaltyProvider, type LoyaltySummary, type NfcSummary } from '../loyalty-provider.js';

const tierOf = (accrued: number) => (accrued >= 500 ? 'Oro (simulado)' : accrued >= 100 ? 'Plata (simulado)' : 'Bronce (simulado)');

/** SIMULADOR de fidelización: libro de puntos en la base de datos local, con datos ficticios. */
@Injectable()
export class MockLoyaltyProvider implements LoyaltyProvider {
  readonly name = 'mock-loyalty';
  readonly simulated = true;
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  private async totals(clinicId: string, patientRef: string) {
    const rows = await this.db.mockLoyaltyEntry.groupBy({ by: ['kind'], where: { clinicId, patientRef }, _sum: { points: true } });
    const accrued = rows.find((r) => r.kind === 'ACCRUAL')?._sum.points ?? 0;
    const redeemed = rows.find((r) => r.kind === 'REDEMPTION')?._sum.points ?? 0;
    return { accrued, redeemed, balance: accrued - redeemed };
  }

  private async write(kind: 'ACCRUAL' | 'REDEMPTION', i: { clinicId: string; patientRef: string; points: number; idempotencyKey: string; reason: string }) {
    try {
      await this.db.mockLoyaltyEntry.create({ data: { clinicId: i.clinicId, patientRef: i.patientRef, kind, points: i.points, reason: i.reason, idempotencyKey: i.idempotencyKey } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // misma clave: ya estaba registrado (idempotencia)
    }
    return { balance: (await this.totals(i.clinicId, i.patientRef)).balance };
  }

  accrue(i: { clinicId: string; patientRef: string; points: number; idempotencyKey: string; reason: string }) {
    return this.write('ACCRUAL', i);
  }

  async redeem(i: { clinicId: string; patientRef: string; points: number; idempotencyKey: string; reason: string }) {
    const done = await this.db.mockLoyaltyEntry.findUnique({ where: { idempotencyKey: i.idempotencyKey } });
    if (done) return { balance: (await this.totals(i.clinicId, i.patientRef)).balance };
    if ((await this.totals(i.clinicId, i.patientRef)).balance < i.points) throw new InsufficientPointsError('Puntos insuficientes');
    return this.write('REDEMPTION', i);
  }

  async summary(i: { clinicId: string; patientRef: string }): Promise<LoyaltySummary> {
    const t = await this.totals(i.clinicId, i.patientRef);
    const recent = await this.db.mockLoyaltyEntry.findMany({ where: { clinicId: i.clinicId, patientRef: i.patientRef }, orderBy: { createdAt: 'desc' }, take: 5 });
    return { ...t, tier: tierOf(t.accrued), recent: recent.map((r) => ({ kind: r.kind as 'ACCRUAL' | 'REDEMPTION', points: r.points, reason: r.reason, at: r.createdAt })) };
  }

  /** Resumen de tarjeta NFC ficticio y determinista (derivado del identificador, sin datos reales). */
  async nfcSummary(i: { clinicId: string; patientRef: string }): Promise<NfcSummary> {
    const h = createHash('sha256').update(i.patientRef).digest();
    const t = await this.totals(i.clinicId, i.patientRef);
    const taps = 2 + (h[0]! % 9);
    return {
      cardLabel: `Tarjeta NFC DEMO ···${h.subarray(1, 3).toString('hex').toUpperCase()}`,
      status: 'Activa (simulada)',
      tapsLast30Days: taps,
      lastTapAt: new Date(Date.now() - (1 + (h[3]! % 20)) * 86_400_000),
      tier: tierOf(t.accrued),
    };
  }
}
