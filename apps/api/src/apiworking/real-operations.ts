import { ConflictException } from '@nestjs/common';
import { AuditAction } from '../audit/audit.service.js';
import type { AppConfig } from '../config/app-config.js';
import type { PrismaDb } from '../prisma/client.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Auditoría que cuenta como «envío real» en el tope (el intento se guarda ANTES de llamar a Apiworking). */
export const REAL_ATTEMPT_ACTIONS: string[] = [
  AuditAction.ApiworkingCashOpenAttempt,
  AuditAction.ApiworkingCashCloseAttempt,
  AuditAction.ApiworkingCustomerAttempt,
];

/** Tope de envíos reales en 24 h: ventas + aperturas/cierres de caja + altas de cliente. */
export async function enforceRealOperationsCap(db: PrismaDb, config: AppConfig): Promise<void> {
  const cfg = config.apiworking;
  const since = new Date(Date.now() - WINDOW_MS);
  const [sales, other] = await Promise.all([
    db.apiworkingSale.count({ where: { tenant: cfg.expectedDatabase!, attemptedAt: { gte: since } } }),
    db.auditLog.count({ where: { action: { in: REAL_ATTEMPT_ACTIONS }, createdAt: { gte: since } } }),
  ]);
  if (sales + other >= cfg.maxRealOperations) {
    throw new ConflictException({ message: `Se alcanzó el tope de ${cfg.maxRealOperations} envíos reales en 24 horas (APIWORKING_MAX_REAL_OPERATIONS)`, code: 'REAL_OPERATIONS_LIMIT' });
  }
}
