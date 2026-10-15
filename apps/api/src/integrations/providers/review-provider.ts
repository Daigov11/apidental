/** Puerto del proveedor de reseñas. Hoy solo existe el simulador. */
export interface ReviewSummary {
  average: number;
  total: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  requestsSent: number;
  recent: { rating: number; comment: string; label: string }[];
}

export interface ReviewProvider {
  readonly name: string;
  readonly simulated: boolean;
  requestReview(input: { clinicId: string; patientRef: string; idempotencyKey: string }): Promise<{ requestId: string; status: string }>;
  summary(input: { clinicId: string }): Promise<ReviewSummary>;
}
