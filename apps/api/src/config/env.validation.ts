import { isAbsolute } from 'node:path';
import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const toInt = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

/** Variables de entorno aceptadas por la API. Se validan al iniciar. */
export class EnvironmentVariables {
  @IsOptional()
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsOptional()
  @IsString()
  HOST: string = '127.0.0.1';

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres' })
  JWT_ACCESS_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ISSUER: string = 'apidental-api';

  @IsOptional()
  @IsString()
  JWT_AUDIENCE: string = 'apidental-admin';

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(60)
  @Max(86_400)
  JWT_ACCESS_TTL_SECONDS: number = 900;

  /** Orígenes permitidos por CORS, separados por coma. */
  @IsOptional()
  @IsString()
  CORS_ORIGINS: string = 'http://localhost:5173';

  /** Número de proxies de confianza delante de la API (Nginx = 1). 0 = ninguno. */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY: number = 0;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  LOGIN_MAX_ATTEMPTS: number = 5;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(1440)
  LOGIN_LOCK_MINUTES: number = 15;

  /**
   * Directorio PRIVADO de adjuntos (fuera del webroot y de cualquier ruta servida por Nginx).
   * En producción debe ser absoluto, p. ej. /var/lib/apidental/files.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ATTACHMENTS_DIR: string = './storage/attachments';

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1024)
  @Max(52_428_800)
  ATTACHMENT_MAX_BYTES: number = 10_485_760;

  // ---------------- sesiones y refresh token ----------------

  /** Inactividad máxima de una sesión (vida del refresh token entre renovaciones). */
  @IsOptional() @Transform(toInt) @IsInt() @Min(300) @Max(2_592_000)
  REFRESH_TTL_SECONDS: number = 28_800;

  /** Tope absoluto de una sesión aunque se renueve continuamente. */
  @IsOptional() @Transform(toInt) @IsInt() @Min(900) @Max(7_776_000)
  SESSION_MAX_SECONDS: number = 604_800;

  /**
   * Tolerancia para dos renovaciones simultáneas con el mismo refresh token (varias pestañas).
   * 0 = estricto: cualquier reutilización revoca la sesión. Un valor > 0 relaja la detección.
   */
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) @Max(30)
  REFRESH_REUSE_GRACE_SECONDS: number = 0;

  /** Cookie `Secure`. Por defecto: true en producción, false en desarrollo/pruebas (http://localhost). */
  @IsOptional() @IsIn(['true', 'false'])
  COOKIE_SECURE?: string;

  // ---------------- reautenticación ----------------

  @IsOptional() @Transform(toInt) @IsInt() @Min(30) @Max(300)
  REAUTH_TTL_SECONDS: number = 120;

  // ---------------- invitaciones y aprovisionamiento ----------------

  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(336)
  INVITATION_TTL_HOURS: number = 72;

  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(90)
  PROVISIONING_RECORD_TTL_DAYS: number = 30;

  /**
   * Canal de entrega del enlace de invitación.
   *  - dev: el enlace se devuelve en la respuesta (SOLO desarrollo/pruebas; prohibido en producción).
   *  - webhook: POST firmado (HMAC) a INVITATION_WEBHOOK_URL; el operador lo conecta a su sistema de envío.
   *  - disabled: no se pueden crear invitaciones (por defecto en producción).
   */
  @IsOptional() @IsIn(['dev', 'webhook', 'disabled'])
  INVITATION_DELIVERY_MODE?: string;

  @IsOptional() @IsString()
  INVITATION_WEBHOOK_URL?: string;

  @IsOptional() @IsString()
  INVITATION_WEBHOOK_SECRET?: string;

  /** URL base de la pantalla de aceptación; el token se agrega en el fragmento (#token=…), nunca en la ruta. */
  @IsOptional() @IsString()
  INVITATION_ACCEPT_BASE_URL: string = 'http://localhost:5173/admin/aceptar-invitacion';

  // ---------------- recuperación de contraseña ----------------

  @IsOptional() @Transform(toInt) @IsInt() @Min(5) @Max(120)
  PASSWORD_RECOVERY_TTL_MINUTES: number = 30;

  /** Tiempo mínimo entre dos solicitudes para la misma cuenta (las demás se ignoran en silencio). */
  @IsOptional() @Transform(toInt) @IsInt() @Min(0) @Max(3600)
  PASSWORD_RECOVERY_COOLDOWN_SECONDS: number = 60;

  /** Tope de recuperaciones por cuenta en 24 h (las demás se ignoran en silencio). */
  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(50)
  PASSWORD_RECOVERY_MAX_PER_DAY: number = 5;

  /** Pantalla de restablecimiento del panel; el token se agrega como fragmento (#token=…). */
  @IsOptional() @IsString()
  PASSWORD_RECOVERY_BASE_URL: string = 'http://localhost:5173/admin/restablecer-contrasena';

  // ---------------- mantenimiento (depuración) ----------------

  /** Días que se conservan las sesiones revocadas o vencidas antes de depurarlas. */
  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(3650)
  RETENTION_SESSIONS_DAYS: number = 30;

  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(3650)
  RETENTION_REAUTH_DAYS: number = 7;

  /** Mínimo 30: la base de datos impide depurar invitaciones o recuperaciones más recientes. */
  @IsOptional() @Transform(toInt) @IsInt() @Min(30) @Max(3650)
  RETENTION_INVITATIONS_DAYS: number = 90;

  @IsOptional() @Transform(toInt) @IsInt() @Min(30) @Max(3650)
  RETENTION_RECOVERIES_DAYS: number = 30;

  @IsOptional() @Transform(toInt) @IsInt() @Min(10) @Max(5000)
  MAINTENANCE_BATCH_SIZE: number = 500;

  /** Tope de lotes por tabla en cada ejecución (acota la duración del trabajo). */
  @IsOptional() @Transform(toInt) @IsInt() @Min(1) @Max(1000)
  MAINTENANCE_MAX_BATCHES: number = 20;

  // ---------------- cifrado de campos (PREPARADO, no se aplica a ninguna columna en 3.2) ----------------

  /** off = sin transformación (por defecto). aes-gcm solo habilita la capa; los servicios aún no la usan. */
  @IsOptional() @IsIn(['off', 'aes-gcm'])
  FIELD_ENCRYPTION_MODE: string = 'off';

  @IsOptional() @IsString()
  FIELD_ENCRYPTION_KEY_ID: string = 'k1';

  /** Clave activa: 32 bytes en base64 (openssl rand -base64 32). Nunca en el repositorio. */
  @IsOptional() @IsString()
  FIELD_ENCRYPTION_KEY?: string;

  /** Claves anteriores para descifrar tras una rotación: "id:base64,id:base64". */
  @IsOptional() @IsString()
  FIELD_ENCRYPTION_OLD_KEYS?: string;

  /**
   * off = sin integraciones (por defecto). mock = SIMULADORES de Apiworking para demostración: no hay credenciales, ni
   * endpoints, ni emisión real. No existe un modo «real» todavía.
   */
  @IsOptional() @IsIn(['off', 'mock'])
  INTEGRATIONS_MODE: string = 'off';

  /** Clínica a la que pertenece la web pública (landing y solicitudes de cita). Sin valor, las rutas públicas responden 404. */
  @IsOptional() @IsUUID()
  PUBLIC_BOOKING_CLINIC_ID?: string;

  /** Los simuladores no arrancan con NODE_ENV=production salvo que se confirme aquí (demostraciones en un servidor). */
  @IsOptional() @IsIn(['true', 'false'])
  INTEGRATIONS_MOCK_ALLOW_PRODUCTION: string = 'false';

  /** Intervalo del procesador de la cola (outbox) en ms; 0 = solo bajo demanda (por defecto). */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  INTEGRATIONS_WORKER_INTERVAL_MS: number = 0;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  RATE_LIMIT_PER_MINUTE: number = 120;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  LOGIN_RATE_LIMIT_PER_MINUTE: number = 10;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
  }
  if (env.SESSION_MAX_SECONDS < env.REFRESH_TTL_SECONDS) {
    throw new Error('Configuración de entorno inválida: SESSION_MAX_SECONDS debe ser >= REFRESH_TTL_SECONDS');
  }
  const production = env.NODE_ENV === NodeEnv.Production;
  const mode = env.INVITATION_DELIVERY_MODE ?? (production ? 'disabled' : 'dev');
  if (mode === 'dev' && production) {
    throw new Error('Configuración de entorno inválida: INVITATION_DELIVERY_MODE=dev no se permite en producción');
  }
  if (mode === 'webhook') {
    if (!env.INVITATION_WEBHOOK_URL || !env.INVITATION_WEBHOOK_SECRET) {
      throw new Error('Configuración de entorno inválida: el canal webhook requiere INVITATION_WEBHOOK_URL e INVITATION_WEBHOOK_SECRET');
    }
    if (env.INVITATION_WEBHOOK_SECRET.length < 32) {
      throw new Error('Configuración de entorno inválida: INVITATION_WEBHOOK_SECRET debe tener al menos 32 caracteres');
    }
    if (production && !/^https:\/\//i.test(env.INVITATION_WEBHOOK_URL)) {
      throw new Error('Configuración de entorno inválida: INVITATION_WEBHOOK_URL debe usar https en producción');
    }
  }
  if (production && mode !== 'disabled' && !/^https:\/\//i.test(env.INVITATION_ACCEPT_BASE_URL)) {
    throw new Error('Configuración de entorno inválida: INVITATION_ACCEPT_BASE_URL debe usar https en producción');
  }
  if (production && mode !== 'disabled' && !/^https:\/\//i.test(env.PASSWORD_RECOVERY_BASE_URL)) {
    throw new Error('Configuración de entorno inválida: PASSWORD_RECOVERY_BASE_URL debe usar https en producción');
  }
  if (env.INTEGRATIONS_MODE === 'mock' && production && env.INTEGRATIONS_MOCK_ALLOW_PRODUCTION !== 'true') {
    throw new Error('Configuración de entorno inválida: INTEGRATIONS_MODE=mock no se permite en producción (INTEGRATIONS_MOCK_ALLOW_PRODUCTION=true solo para demostraciones)');
  }
  if (env.FIELD_ENCRYPTION_MODE === 'aes-gcm') {
    if (!env.FIELD_ENCRYPTION_KEY || Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64').length !== 32) {
      throw new Error('Configuración de entorno inválida: FIELD_ENCRYPTION_KEY debe ser una clave de 32 bytes en base64');
    }
  }
  if (production && env.COOKIE_SECURE === 'false') {
    throw new Error('Configuración de entorno inválida: COOKIE_SECURE no puede ser false en producción');
  }
  if (env.NODE_ENV === NodeEnv.Production) {
    if (/change[_-]?me/i.test(env.JWT_ACCESS_SECRET)) {
      throw new Error(
        'Configuración de entorno inválida: JWT_ACCESS_SECRET usa el valor de ejemplo en producción',
      );
    }
    if (!isAbsolute(env.ATTACHMENTS_DIR)) {
      throw new Error('Configuración de entorno inválida: ATTACHMENTS_DIR debe ser una ruta absoluta en producción');
    }
    if (env.CORS_ORIGINS.includes('*')) {
      throw new Error('Configuración de entorno inválida: CORS_ORIGINS no admite "*" en producción');
    }
  }
  return env;
}
