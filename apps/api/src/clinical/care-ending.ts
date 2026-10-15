import { AuditAction, type AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { DbTx } from '../prisma/client.js';

/**
 * Termina, por una causa del SISTEMA (rol retirado, usuario deshabilitado, vigencia vencida), las relaciones
 * asistenciales vigentes de un odontólogo. Debe invocarse dentro de la transacción que provoca la causa y
 * DESPUÉS de haber tomado el bloqueo de la fila del usuario (la creación de relaciones también lo toma): así
 * ninguna relación nueva puede colarse entre la causa y este cierre. Una reactivación posterior NO las restaura.
 */
export async function endCareRelationshipsOf(
  tx: DbTx,
  audit: AuditService,
  params: {
    dentistUserId: string;
    /** Limita a una clínica; omitido = todas las clínicas del usuario. */
    clinicId?: string | null;
    actorId: string | null;
    endKind: 'SYSTEM' | 'EXPIRED';
    reason: string;
    meta: RequestMeta | null;
  },
): Promise<number> {
  const rows = await tx.patientCareRelationship.findMany({
    where: {
      dentistUserId: params.dentistUserId,
      status: 'ACTIVE',
      ...(params.clinicId ? { clinicId: params.clinicId } : {}),
    },
    select: { id: true, clinicId: true, patientId: true, branchId: true },
  });
  if (rows.length === 0) return 0;
  await tx.patientCareRelationship.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: 'ACTIVE' },
    data: {
      status: 'ENDED',
      activeKey: null,
      endedAt: new Date(),
      endedById: params.actorId,
      endKind: params.endKind,
      endReason: params.reason,
    },
  });
  for (const r of rows) {
    await audit.record(
      {
        action: AuditAction.CareRelationshipEnded,
        entity: 'PatientCareRelationship',
        entityId: r.id,
        patientId: r.patientId,
        userId: params.actorId,
        clinicId: r.clinicId,
        branchId: r.branchId,
        meta: params.meta,
        summary: {
          endKind: params.endKind,
          reason: params.reason,
          dentistUserId: params.dentistUserId,
        },
      },
      tx,
    );
  }
  return rows.length;
}
