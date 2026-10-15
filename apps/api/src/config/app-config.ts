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
