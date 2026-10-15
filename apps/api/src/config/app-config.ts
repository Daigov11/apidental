import { resolve } from 'node:path';
import { NodeEnv, validateEnv } from './env.validation.js';

/** Configuración tipada de la aplicación, construida una sola vez desde el entorno. */
export class AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly jwt: {
    secret: string;
    issuer: string;
    audience: string;
    accessTtlSeconds: number;
  };
  readonly attachments: { dir: string; maxBytes: number };
  readonly session: {
    refreshTtlSeconds: number;
    absoluteSeconds: number;
    reuseGraceSeconds: number;
    cookie: { name: string; secure: boolean };
  };
  readonly reauthTtlSeconds: number;
  readonly invitations: {
    ttlHours: number;
    mode: 'dev' | 'webhook' | 'disabled';
    webhookUrl: string | null;
    webhookSecret: string | null;
    acceptBaseUrl: string;
  };
  readonly provisioningTtlDays: number;
  readonly passwordRecovery: { ttlMinutes: number; cooldownSeconds: number; maxPerDay: number; baseUrl: string };
  readonly maintenance: {
    retention: { sessionsDays: number; reauthDays: number; invitationsDays: number; recoveriesDays: number };
    batchSize: number;
    maxBatches: number;
  };
  readonly corsOrigins: string[];
  readonly trustProxy: number;
  readonly login: { maxAttempts: number; lockMinutes: number };
  readonly rateLimit: { perMinute: number; loginPerMinute: number };

  constructor(raw: Record<string, unknown> = process.env) {
    const env = validateEnv(raw);
    this.nodeEnv = env.NODE_ENV;
    this.isProduction = env.NODE_ENV === NodeEnv.Production;
    this.isTest = env.NODE_ENV === NodeEnv.Test;
    this.host = env.HOST;
    this.port = env.PORT;
    this.databaseUrl = env.DATABASE_URL;
    this.jwt = {
      secret: env.JWT_ACCESS_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    };
    this.attachments = { dir: resolve(env.ATTACHMENTS_DIR), maxBytes: env.ATTACHMENT_MAX_BYTES };
    const secure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : this.isProduction;
    this.session = {
      refreshTtlSeconds: env.REFRESH_TTL_SECONDS,
      absoluteSeconds: env.SESSION_MAX_SECONDS,
      reuseGraceSeconds: env.REFRESH_REUSE_GRACE_SECONDS,
      // El prefijo __Host- exige Secure, Path=/ y ausencia de Domain (cookie ligada a un único host).
      cookie: { name: secure ? '__Host-apidental_rt' : 'apidental_rt', secure },
    };
    this.reauthTtlSeconds = env.REAUTH_TTL_SECONDS;
    this.invitations = {
      ttlHours: env.INVITATION_TTL_HOURS,
      mode: (env.INVITATION_DELIVERY_MODE ?? (this.isProduction ? 'disabled' : 'dev')) as 'dev' | 'webhook' | 'disabled',
      webhookUrl: env.INVITATION_WEBHOOK_URL ?? null,
      webhookSecret: env.INVITATION_WEBHOOK_SECRET ?? null,
      acceptBaseUrl: env.INVITATION_ACCEPT_BASE_URL,
    };
    this.provisioningTtlDays = env.PROVISIONING_RECORD_TTL_DAYS;
    this.passwordRecovery = {
      ttlMinutes: env.PASSWORD_RECOVERY_TTL_MINUTES,
      cooldownSeconds: env.PASSWORD_RECOVERY_COOLDOWN_SECONDS,
      maxPerDay: env.PASSWORD_RECOVERY_MAX_PER_DAY,
      baseUrl: env.PASSWORD_RECOVERY_BASE_URL,
    };
    this.maintenance = {
      retention: {
        sessionsDays: env.RETENTION_SESSIONS_DAYS,
        reauthDays: env.RETENTION_REAUTH_DAYS,
        invitationsDays: env.RETENTION_INVITATIONS_DAYS,
        recoveriesDays: env.RETENTION_RECOVERIES_DAYS,
      },
      batchSize: env.MAINTENANCE_BATCH_SIZE,
      maxBatches: env.MAINTENANCE_MAX_BATCHES,
    };
    this.corsOrigins = env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    this.trustProxy = env.TRUST_PROXY;
    this.login = { maxAttempts: env.LOGIN_MAX_ATTEMPTS, lockMinutes: env.LOGIN_LOCK_MINUTES };
    this.rateLimit = {
      perMinute: env.RATE_LIMIT_PER_MINUTE,
      loginPerMinute: env.LOGIN_RATE_LIMIT_PER_MINUTE,
    };
  }
}
