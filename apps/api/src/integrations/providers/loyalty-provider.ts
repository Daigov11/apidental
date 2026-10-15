/** Puerto del proveedor de fidelización (puntos, canjes y resumen NFC). Hoy solo existe el simulador. */
export interface LoyaltyEvent { kind: 'ACCRUAL' | 'REDEMPTION'; points: number; reason: string | null; at: Date }
export interface LoyaltySummary { balance: number; accrued: number; redeemed: number; tier: string; recent: LoyaltyEvent[] }
export interface NfcSummary { cardLabel: string; status: string; tapsLast30Days: number; lastTapAt: Date | null; tier: string }

export class InsufficientPointsError extends Error {}

export interface LoyaltyProvider {
  readonly name: string;
  readonly simulated: boolean;
  accrue(input: { clinicId: string; patientRef: string; points: number; idempotencyKey: string; reason: string }): Promise<{ balance: number }>;
  redeem(input: { clinicId: string; patientRef: string; points: number; idempotencyKey: string; reason: string }): Promise<{ balance: number }>;
  summary(input: { clinicId: string; patientRef: string }): Promise<LoyaltySummary>;
  nfcSummary(input: { clinicId: string; patientRef: string }): Promise<NfcSummary>;
}
