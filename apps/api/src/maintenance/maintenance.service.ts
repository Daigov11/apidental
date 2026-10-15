import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { PasswordRecoveryService } from '../auth/password-recovery.service.js';
import { AppConfig } from '../config/app-config.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';

export interface MaintenanceReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  /** Pendientes cuyo plazo terminó y se marcaron como vencidos (o se vencerían, en dry-run). */
  expired: {
    invitations: number;
    passwordRecoveries: number;
    provisioningRecords: number;
    sessions: number;
    careRelationships: number;
  };
  /** Registros eliminados por haber superado su retención (o que se eliminarían, en dry-run). */
  purged: {
    sessions: number;
    reauthProofs: number;
    invitations: number;
    passwordRecoveries: number;
  };
  /** true si algún lote alcanzó el tope por ejecución: conviene volver a ejecutar. */
  truncated: boolean;
}

/**
 * Mantenimiento de seguridad: vence lo caducado y depura lo cerrado que superó su retención.
 *
 * Qué se conserva SIEMPRE: la auditoría (inmutable), los usuarios, las asignaciones, los registros de
 * aprovisionamiento y todo lo que sigue PENDIENTE o activo. Qué se depura: sesiones revocadas o vencidas
 * (con sus refresh tokens y pruebas), pruebas de reautenticación caducadas, y las invitaciones y
 * recuperaciones ya cerradas. La base de datos exige además un mínimo de 30 días para invitaciones y
 * recuperaciones (trigger), aunque la configuración pidiera menos.
 *
 * Es idempotente y seguro de repetir; se ejecuta con `npm run maintenance` (ver README).
 */
@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly invitations: InvitationsService,
    private readonly provisioning: ProvisioningService,
    private readonly recoveries: PasswordRecoveryService,
  ) {}

  async run(
    opts: { dryRun?: boolean; now?: Date } = {},
  ): Promise<MaintenanceReport> {
    const dryRun = Boolean(opts.dryRun);
    const now = opts.now ?? new Date();
    const startedAt = new Date().toISOString();
    const { retention, batchSize, maxBatches } = this.config.maintenance;
    const cutoff = (days: number) =>
      new Date(now.getTime() - days * 86_400_000);

    // ---- 1) vencer lo caducado ----
    const expired = {
      invitations: 0,
      passwordRecoveries: 0,
      provisioningRecords: 0,
      sessions: 0,
      careRelationships: 0,
    };
    if (dryRun) {
      expired.invitations = await this.db.invitation.count({
        where: { status: 'PENDING', expiresAt: { lte: now } },
      });
      expired.passwordRecoveries = await this.db.passwordRecovery.count({
        where: { status: 'PENDING', expiresAt: { lte: now } },
      });
      expired.provisioningRecords = await this.db.provisioningRecord.count({
        where: { status: 'ACTIVE', expiresAt: { lte: now } },
      });
      expired.sessions = await this.db.authSession.count({
        where: this.staleSessionFilter(now),
      });
      expired.careRelationships = await this.db.patientCareRelationship.count({
        where: this.lapsedCareFilter(now),
      });
    } else {
      expired.invitations = await this.drain(
        () => this.invitations.expireDue(),
        maxBatches,
      );
      expired.passwordRecoveries = await this.drain(
        () => this.recoveries.expireDue(),
        maxBatches,
      );
      expired.provisioningRecords = await this.drain(
        () => this.provisioning.expireDue(),
        maxBatches,
      );
      expired.sessions = await this.expireSessions(now, batchSize, maxBatches);
      expired.careRelationships = await this.expireCareRelationships(
        now,
        batchSize,
        maxBatches,
      );
    }

    // ---- 2) depurar lo cerrado que superó su retención ----
    let truncated = false;
    const purged = {
      sessions: 0,
      reauthProofs: 0,
      invitations: 0,
      passwordRecoveries: 0,
    };
    const sessionsWhere = { revokedAt: { lt: cutoff(retention.sessionsDays) } };
    const proofsWhere = { expiresAt: { lt: cutoff(retention.reauthDays) } };
    const invitationsWhere = {
      status: { not: 'PENDING' as const },
      expiresAt: { lt: cutoff(retention.invitationsDays) },
    };
    const recoveriesWhere = {
      status: { not: 'PENDING' as const },
      expiresAt: { lt: cutoff(retention.recoveriesDays) },
    };

    if (dryRun) {
      purged.sessions = await this.db.authSession.count({
        where: sessionsWhere,
      });
      purged.reauthProofs = await this.db.reauthProof.count({
        where: proofsWhere,
      });
      purged.invitations = await this.db.invitation.count({
        where: invitationsWhere,
      });
      purged.passwordRecoveries = await this.db.passwordRecovery.count({
        where: recoveriesWhere,
      });
    } else {
      const run = async (
        find: (take: number) => Promise<{ id: string }[]>,
        del: (ids: string[]) => Promise<{ count: number }>,
      ) => {
        let total = 0;
        for (let i = 0; i < maxBatches; i++) {
          const ids = (await find(batchSize)).map((r) => r.id);
          if (ids.length === 0) return total;
          total += (await del(ids)).count;
          if (ids.length < batchSize) return total;
          if (i === maxBatches - 1) truncated = true;
        }
        return total;
      };
      // Las sesiones se eliminan en cascada con sus refresh tokens y pruebas de reautenticación.
      purged.sessions = await run(
        (take) =>
          this.db.authSession.findMany({
            where: sessionsWhere,
            select: { id: true },
            take,
          }),
        (ids) => this.db.authSession.deleteMany({ where: { id: { in: ids } } }),
      );
      purged.reauthProofs = await run(
        (take) =>
          this.db.reauthProof.findMany({
            where: proofsWhere,
            select: { id: true },
            take,
          }),
        (ids) => this.db.reauthProof.deleteMany({ where: { id: { in: ids } } }),
      );
      purged.invitations = await run(
        (take) =>
          this.db.invitation.findMany({
            where: invitationsWhere,
            select: { id: true },
            take,
          }),
        (ids) => this.db.invitation.deleteMany({ where: { id: { in: ids } } }),
      );
      purged.passwordRecoveries = await run(
        (take) =>
          this.db.passwordRecovery.findMany({
            where: recoveriesWhere,
            select: { id: true },
            take,
          }),
        (ids) =>
          this.db.passwordRecovery.deleteMany({ where: { id: { in: ids } } }),
      );
    }

    const report: MaintenanceReport = {
      dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      expired,
      purged,
      truncated,
    };
    if (!dryRun) {
      await this.audit.recordSafely({
        action: AuditAction.MaintenancePurge,
        entity: 'System',
        // Solo contadores: nunca ids, correos ni tokens.
        summary: { expired, purged, truncated, retentionDays: retention },
      });
    }
    return report;
  }

  // ------------------------------------------------------------------ internos

  /** Sesiones activas que ya no pueden renovarse: pasaron su tope absoluto o no les queda ningún refresh token vigente. */
  private staleSessionFilter(now: Date) {
    return {
      revokedAt: null,
      OR: [
        { absoluteExpiresAt: { lte: now } },
        {
          refreshTokens: {
            none: { status: 'ACTIVE' as const, expiresAt: { gt: now } },
          },
        },
      ],
    };
  }

  /** Relaciones asistenciales con vigencia (p. ej. la de una cita) que ya venció: dejan de otorgar acceso y se cierran. */
  private lapsedCareFilter(now: Date) {
    return { status: 'ACTIVE' as const, validUntil: { lte: now } };
  }

  private async expireCareRelationships(
    now: Date,
    batchSize: number,
    maxBatches: number,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const lapsed = await this.db.patientCareRelationship.findMany({
        where: this.lapsedCareFilter(now),
        select: {
          id: true,
          clinicId: true,
          patientId: true,
          branchId: true,
          dentistUserId: true,
        },
        take: batchSize,
      });
      if (lapsed.length === 0) break;
      for (const r of lapsed) {
        await this.db.$transaction(async (tx) => {
          const ended = await tx.patientCareRelationship.updateMany({
            where: { id: r.id, status: 'ACTIVE' },
            data: {
              status: 'ENDED',
              activeKey: null,
              endedAt: now,
              endedById: null,
              endKind: 'EXPIRED',
              endReason: 'Venció la vigencia de la relación asistencial',
            },
          });
          if (ended.count === 1) {
            total += 1;
            await this.audit.record(
              {
                action: AuditAction.CareRelationshipEnded,
                entity: 'PatientCareRelationship',
                entityId: r.id,
                patientId: r.patientId,
                clinicId: r.clinicId,
                branchId: r.branchId,
                summary: { endKind: 'EXPIRED', dentistUserId: r.dentistUserId },
              },
              tx,
            );
          }
        });
      }
      if (lapsed.length < batchSize) break;
    }
    return total;
  }

  private async expireSessions(
    now: Date,
    batchSize: number,
    maxBatches: number,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const stale = await this.db.authSession.findMany({
        where: this.staleSessionFilter(now),
        select: { id: true },
        take: batchSize,
      });
      if (stale.length === 0) break;
      const ids = stale.map((s) => s.id);
      const res = await this.db.authSession.updateMany({
        where: { id: { in: ids }, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'EXPIRED' },
      });
      await this.db.refreshToken.updateMany({
        where: { sessionId: { in: ids }, status: 'ACTIVE' },
        data: { status: 'REVOKED' },
      });
      total += res.count;
      if (stale.length < batchSize) break;
    }
    return total;
  }

  private async drain(
    step: () => Promise<number>,
    maxBatches: number,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const n = await step();
      total += n;
      if (n === 0) break;
    }
    return total;
  }
}
