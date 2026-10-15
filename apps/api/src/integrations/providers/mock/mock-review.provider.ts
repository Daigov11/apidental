import { Inject, Injectable } from '@nestjs/common';
import type { PrismaDb } from '../../../prisma/client.js';
import { PRISMA } from '../../../prisma/prisma.module.js';
import { isUniqueViolation } from '../../../patients/patient-access.js';
import type { ReviewProvider, ReviewSummary } from '../review-provider.js';

/** SIMULADOR de reseñas: agregados y comentarios FICTICIOS; solo las solicitudes enviadas son reales (locales). */
@Injectable()
export class MockReviewProvider implements ReviewProvider {
  readonly name = 'mock-review';
  readonly simulated = true;
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  async requestReview(i: { clinicId: string; patientRef: string; idempotencyKey: string }) {
    try {
      await this.db.mockReviewRequest.create({ data: { clinicId: i.clinicId, patientRef: i.patientRef, idempotencyKey: i.idempotencyKey } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    const row = await this.db.mockReviewRequest.findUniqueOrThrow({ where: { idempotencyKey: i.idempotencyKey } });
    return { requestId: `DEMO-RES-${row.id.slice(0, 8).toUpperCase()}`, status: 'Solicitud enviada (simulada)' };
  }

  async summary(i: { clinicId: string }): Promise<ReviewSummary> {
    const requestsSent = await this.db.mockReviewRequest.count({ where: { clinicId: i.clinicId } });
    return {
      average: 4.6,
      total: 128,
      distribution: { '1': 2, '2': 3, '3': 9, '4': 34, '5': 80 },
      requestsSent,
      recent: [
        { rating: 5, comment: 'Reseña de demostración: atención amable y puntual (ficticia).', label: 'Paciente A (ficticio)' },
        { rating: 4, comment: 'Reseña de demostración: buen trato, la sala de espera estaba llena (ficticia).', label: 'Paciente B (ficticio)' },
        { rating: 5, comment: 'Reseña de demostración: explicaron todo con claridad (ficticia).', label: 'Paciente C (ficticio)' },
      ],
    };
  }
}
