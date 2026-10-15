import { AppConfig } from './app-config.js';
import { validateEnv } from './env.validation.js';

const base = {
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
};

describe('validateEnv', () => {
  it('aplica valores por defecto seguros', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.LOGIN_MAX_ATTEMPTS).toBe(5);
  });

  it('convierte números desde strings', () => {
    expect(validateEnv({ ...base, PORT: '4100', TRUST_PROXY: '1' })).toMatchObject({ PORT: 4100, TRUST_PROXY: 1 });
  });

  it('exige DATABASE_URL y un secreto JWT largo', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'corto' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rechaza valores fuera de rango', () => {
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('valida el almacenamiento de adjuntos: absoluto en producción y tamaño acotado', () => {
    const prod = { ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'x'.repeat(40) };
    expect(() => validateEnv({ ...prod, ATTACHMENTS_DIR: './storage' })).toThrow(/ATTACHMENTS_DIR/);
    expect(() => validateEnv({ ...prod, ATTACHMENTS_DIR: '/var/lib/apidental/files' })).not.toThrow();
    expect(validateEnv(base).ATTACHMENT_MAX_BYTES).toBe(10_485_760);
    expect(() => validateEnv({ ...base, ATTACHMENT_MAX_BYTES: '999999999' })).toThrow(/ATTACHMENT_MAX_BYTES/);
  });

  it('en producción rechaza el secreto de ejemplo y CORS comodín', () => {
    const prod = { ...base, NODE_ENV: 'production', ATTACHMENTS_DIR: '/var/lib/apidental/files' };
    expect(() => validateEnv({ ...prod, JWT_ACCESS_SECRET: 'change_me_'.repeat(5) })).toThrow(/ejemplo/);
    expect(() => validateEnv({ ...prod, CORS_ORIGINS: '*' })).toThrow(/CORS/);
    expect(() => validateEnv({ ...prod, CORS_ORIGINS: 'https://dental.apiworking.com.pe' })).not.toThrow();
  });

  it('integraciones: apagadas por defecto; solo existe el modo mock; mock exige confirmación en producción', () => {
    expect(new AppConfig(base).integrations).toEqual({ mode: 'off', workerIntervalMs: 0 });
    expect(new AppConfig({ ...base, INTEGRATIONS_MODE: 'mock' }).integrations.mode).toBe('mock');
    expect(() => validateEnv({ ...base, INTEGRATIONS_MODE: 'real' })).toThrow(/INTEGRATIONS_MODE/);
    const prod = { ...base, NODE_ENV: 'production', ATTACHMENTS_DIR: '/var/lib/apidental/files', INTEGRATIONS_MODE: 'mock' };
    expect(() => validateEnv(prod)).toThrow(/mock no se permite en producción/);
    expect(() => validateEnv({ ...prod, INTEGRATIONS_MOCK_ALLOW_PRODUCTION: 'true' })).not.toThrow();
  });

  describe('sesiones, cookie e invitaciones', () => {
    it('valores por defecto: refresh 8 h, tope 7 días, estricto ante reutilización, reautenticación 2 min, invitación 72 h', () => {
      const env = validateEnv(base);
      expect(env).toMatchObject({
        REFRESH_TTL_SECONDS: 28_800,
        SESSION_MAX_SECONDS: 604_800,
        REFRESH_REUSE_GRACE_SECONDS: 0,
        REAUTH_TTL_SECONDS: 120,
        INVITATION_TTL_HOURS: 72,
      });
    });

    it('el tope absoluto no puede ser menor que la vida del refresh token', () => {
      expect(() => validateEnv({ ...base, REFRESH_TTL_SECONDS: '7200', SESSION_MAX_SECONDS: '3600' })).toThrow(/SESSION_MAX_SECONDS/);
    });

    it('acota la reautenticación y la gracia de reutilización', () => {
      expect(() => validateEnv({ ...base, REAUTH_TTL_SECONDS: '5000' })).toThrow(/REAUTH_TTL_SECONDS/);
      expect(() => validateEnv({ ...base, REAUTH_TTL_SECONDS: '10' })).toThrow(/REAUTH_TTL_SECONDS/);
      expect(() => validateEnv({ ...base, REFRESH_REUSE_GRACE_SECONDS: '600' })).toThrow(/REFRESH_REUSE_GRACE_SECONDS/);
    });

    const prod = { ...base, NODE_ENV: 'production', ATTACHMENTS_DIR: '/var/lib/apidental/files', CORS_ORIGINS: 'https://dental.apiworking.com.pe' };

    it('en producción el canal "dev" (enlace en la respuesta) está PROHIBIDO', () => {
      expect(() => validateEnv({ ...prod, INVITATION_DELIVERY_MODE: 'dev' })).toThrow(/dev no se permite en producción/);
    });

    it('en producción, sin configurar nada, las invitaciones quedan deshabilitadas (falla cerrada)', () => {
      expect(() => validateEnv(prod)).not.toThrow();
      const config = new AppConfig(prod);
      expect(config.invitations.mode).toBe('disabled');
    });

    it('el canal webhook exige URL, secreto largo y https en producción', () => {
      const webhook = { ...prod, INVITATION_DELIVERY_MODE: 'webhook', INVITATION_ACCEPT_BASE_URL: 'https://dental.apiworking.com.pe/admin/aceptar-invitacion', PASSWORD_RECOVERY_BASE_URL: 'https://dental.apiworking.com.pe/admin/restablecer-contrasena' };
      expect(() => validateEnv(webhook)).toThrow(/INVITATION_WEBHOOK_URL/);
      expect(() => validateEnv({ ...webhook, INVITATION_WEBHOOK_URL: 'https://mail.interno/hook', INVITATION_WEBHOOK_SECRET: 'corto' })).toThrow(/32 caracteres/);
      expect(() => validateEnv({ ...webhook, INVITATION_WEBHOOK_URL: 'http://mail.interno/hook', INVITATION_WEBHOOK_SECRET: 'x'.repeat(40) })).toThrow(/https/);
      expect(() => validateEnv({ ...webhook, INVITATION_WEBHOOK_URL: 'https://mail.interno/hook', INVITATION_WEBHOOK_SECRET: 'x'.repeat(40) })).not.toThrow();
    });

    it('en producción la URL de aceptación debe ser https y la cookie no puede ser insegura', () => {
      const webhook = { ...prod, INVITATION_DELIVERY_MODE: 'webhook', INVITATION_WEBHOOK_URL: 'https://mail.interno/hook', INVITATION_WEBHOOK_SECRET: 'x'.repeat(40), PASSWORD_RECOVERY_BASE_URL: 'https://dental.apiworking.com.pe/admin/restablecer-contrasena' };
      expect(() => validateEnv({ ...webhook, INVITATION_ACCEPT_BASE_URL: 'http://dental.apiworking.com.pe/x' })).toThrow(/INVITATION_ACCEPT_BASE_URL/);
      expect(() => validateEnv({ ...webhook, INVITATION_ACCEPT_BASE_URL: 'https://dental.apiworking.com.pe/x', PASSWORD_RECOVERY_BASE_URL: 'http://dental.apiworking.com.pe/y' })).toThrow(/PASSWORD_RECOVERY_BASE_URL/);
      expect(() => validateEnv({ ...prod, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    });

    it('recuperación de contraseña y retención: valores por defecto y límites', () => {
      expect(validateEnv(base)).toMatchObject({
        PASSWORD_RECOVERY_TTL_MINUTES: 30,
        PASSWORD_RECOVERY_COOLDOWN_SECONDS: 60,
        PASSWORD_RECOVERY_MAX_PER_DAY: 5,
        RETENTION_SESSIONS_DAYS: 30,
        RETENTION_INVITATIONS_DAYS: 90,
        MAINTENANCE_BATCH_SIZE: 500,
      });
      expect(() => validateEnv({ ...base, PASSWORD_RECOVERY_TTL_MINUTES: '1' })).toThrow(/PASSWORD_RECOVERY_TTL_MINUTES/);
      expect(() => validateEnv({ ...base, PASSWORD_RECOVERY_TTL_MINUTES: '600' })).toThrow(/PASSWORD_RECOVERY_TTL_MINUTES/);
      // la base de datos exige 30 días como mínimo para invitaciones y recuperaciones
      expect(() => validateEnv({ ...base, RETENTION_INVITATIONS_DAYS: '10' })).toThrow(/RETENTION_INVITATIONS_DAYS/);
      expect(() => validateEnv({ ...base, RETENTION_RECOVERIES_DAYS: '29' })).toThrow(/RETENTION_RECOVERIES_DAYS/);
      expect(() => validateEnv({ ...base, MAINTENANCE_BATCH_SIZE: '1' })).toThrow(/MAINTENANCE_BATCH_SIZE/);
    });

    it('el cifrado de campos está apagado por defecto y, si se enciende, exige una clave de 32 bytes', () => {
      expect(new AppConfig(base).fieldEncryption).toMatchObject({ mode: 'off', key: null });
      const key = Buffer.alloc(32, 7).toString('base64');
      expect(new AppConfig({ ...base, FIELD_ENCRYPTION_MODE: 'aes-gcm', FIELD_ENCRYPTION_KEY: key }).fieldEncryption.mode).toBe('aes-gcm');
      expect(() => validateEnv({ ...base, FIELD_ENCRYPTION_MODE: 'aes-gcm' })).toThrow(/FIELD_ENCRYPTION_KEY/);
      expect(() => validateEnv({ ...base, FIELD_ENCRYPTION_MODE: 'aes-gcm', FIELD_ENCRYPTION_KEY: 'corta' })).toThrow(/32 bytes/);
      expect(() => validateEnv({ ...base, FIELD_ENCRYPTION_MODE: 'rot13' })).toThrow(/FIELD_ENCRYPTION_MODE/);
    });

    it('en desarrollo el canal "dev" es el valor por defecto', () => {
      expect(new AppConfig(base).invitations.mode).toBe('dev');
    });
  });
});
