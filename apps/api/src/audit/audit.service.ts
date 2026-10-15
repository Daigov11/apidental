import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { redact } from '../common/utils/redact.js';

export const AuditAction = {
  LoginSuccess: 'LOGIN_SUCCESS',
  LoginFailed: 'LOGIN_FAILED',
  LoginLocked: 'LOGIN_LOCKED',
  LoginBlocked: 'LOGIN_BLOCKED',
  ContextSelected: 'CONTEXT_SELECTED',
  ContextDenied: 'CONTEXT_DENIED',
  ClinicCreated: 'CLINIC_CREATED',
  BranchCreated: 'BRANCH_CREATED',
  UserCreated: 'USER_CREATED',
  AssignmentCreated: 'ASSIGNMENT_CREATED',
  AssignmentReactivated: 'ASSIGNMENT_REACTIVATED',
  AssignmentRevoked: 'ASSIGNMENT_REVOKED',
  // --- Sesiones y reautenticación ---
  SessionLogout: 'SESSION_LOGOUT',
  SessionLogoutAll: 'SESSION_LOGOUT_ALL',
  RefreshReuseDetected: 'REFRESH_REUSE_DETECTED',
  ReauthSucceeded: 'REAUTH_SUCCEEDED',
  ReauthFailed: 'REAUTH_FAILED',
  ReauthConsumed: 'REAUTH_CONSUMED',
  // --- Invitaciones y aprovisionamiento ---
  InvitationCreated: 'INVITATION_CREATED',
  InvitationSent: 'INVITATION_SENT',
  InvitationDeliveryFailed: 'INVITATION_DELIVERY_FAILED',
  InvitationResent: 'INVITATION_RESENT',
  InvitationAccepted: 'INVITATION_ACCEPTED',
  InvitationRejected: 'INVITATION_REJECTED',
  InvitationRevoked: 'INVITATION_REVOKED',
  InvitationExpired: 'INVITATION_EXPIRED',
  DirectorRoleGranted: 'DIRECTOR_ROLE_GRANTED',
  ProvisioningRecorded: 'PROVISIONING_RECORDED',
  ProvisioningConsumed: 'PROVISIONING_CONSUMED',
  ProvisioningRevoked: 'PROVISIONING_REVOKED',
  ProvisioningExpired: 'PROVISIONING_EXPIRED',
  LastAuthorityBlocked: 'LAST_AUTHORITY_BLOCKED',
  // --- Recuperación de contraseña ---
  PasswordRecoveryRequested: 'PASSWORD_RECOVERY_REQUESTED',
  PasswordRecoverySent: 'PASSWORD_RECOVERY_SENT',
  PasswordRecoveryDeliveryFailed: 'PASSWORD_RECOVERY_DELIVERY_FAILED',
  PasswordRecoveryCompleted: 'PASSWORD_RECOVERY_COMPLETED',
  PasswordRecoveryRejected: 'PASSWORD_RECOVERY_REJECTED',
  PasswordRecoveryExpired: 'PASSWORD_RECOVERY_EXPIRED',
  // --- Estado de usuarios, accesos denegados y mantenimiento ---
  UserDisabled: 'USER_DISABLED',
  UserReactivated: 'USER_REACTIVATED',
  AccessDenied: 'ACCESS_DENIED',
  ReauthRejected: 'REAUTH_REJECTED',
  MaintenancePurge: 'MAINTENANCE_PURGE',
  // --- Pacientes (lecturas incluidas: son datos personales) ---
  PatientCreated: 'PATIENT_CREATED',
  PatientViewed: 'PATIENT_VIEWED',
  PatientSearched: 'PATIENT_SEARCHED',
  PatientUpdated: 'PATIENT_UPDATED',
  PatientDeactivated: 'PATIENT_DEACTIVATED',
  PatientReactivated: 'PATIENT_REACTIVATED',
  IdentifierChanged: 'PATIENT_IDENTIFIER_CHANGED',
  ContactAdded: 'PATIENT_CONTACT_ADDED',
  ContactChanged: 'PATIENT_CONTACT_CHANGED',
  ContactRetired: 'PATIENT_CONTACT_RETIRED',
  GuardianLinked: 'PATIENT_GUARDIAN_LINKED',
  GuardianUnlinked: 'PATIENT_GUARDIAN_UNLINKED',
  GuardiansViewed: 'PATIENT_GUARDIANS_VIEWED',
  DuplicatesViewed: 'PATIENT_DUPLICATES_VIEWED',
  DuplicateReportViewed: 'PATIENT_DUPLICATE_REPORT_VIEWED',
  ConsentGranted: 'CONSENT_GRANTED',
  ConsentRevoked: 'CONSENT_REVOKED',
  ConsentListed: 'CONSENT_LISTED',
  AttachmentUploaded: 'ATTACHMENT_UPLOADED',
  AttachmentListed: 'ATTACHMENT_LISTED',
  AttachmentDownloaded: 'ATTACHMENT_DOWNLOADED',
  AttachmentRemoved: 'ATTACHMENT_REMOVED',
} as const;

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  userId?: string | null;
  clinicId?: string | null;
  branchId?: string | null;
  /** Paciente involucrado, si aplica. */
  patientId?: string | null;
  meta?: RequestMeta | null;
  /** Resumen seguro: se filtran claves sensibles. Nunca incluir datos clínicos. */
  summary?: Record<string, unknown> | null;
}

/**
 * Único punto de escritura de auditoría. Solo expone `record` (insertar) y `list` (leer):
 * la inmutabilidad se refuerza además con triggers en la base de datos.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  /** Registra un evento. Dentro de una transacción pasa `tx` para que sea atómico con el cambio. */
  async record(entry: AuditEntry, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        userId: entry.userId ?? null,
        clinicId: entry.clinicId ?? null,
        branchId: entry.branchId ?? null,
        patientId: entry.patientId ?? null,
        ip: entry.meta?.ip ?? null,
        userAgent: entry.meta?.userAgent ?? null,
        summary: entry.summary ? (redact(entry.summary) as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  /** Para eventos de seguridad no críticos (p. ej. login fallido): un error de auditoría no tumba la solicitud. */
  async recordSafely(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (error) {
      this.logger.error(
        `No se pudo registrar auditoría ${entry.action}: ${error instanceof Error ? error.message : 'error'}`,
      );
    }
  }

  list(params: {
    clinicId?: string | null;
    action?: string;
    userId?: string;
    patientId?: string;
    limit: number;
    offset: number;
  }) {
    return this.db.auditLog.findMany({
      where: {
        ...(params.clinicId ? { clinicId: params.clinicId } : {}),
        ...(params.action ? { action: params.action } : {}),
        ...(params.userId ? { userId: params.userId } : {}),
        ...(params.patientId ? { patientId: params.patientId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.limit,
      skip: params.offset,
    });
  }
}
