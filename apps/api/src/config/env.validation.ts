import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
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
  if (env.NODE_ENV === NodeEnv.Production) {
    if (/change[_-]?me/i.test(env.JWT_ACCESS_SECRET)) {
      throw new Error(
        'Configuración de entorno inválida: JWT_ACCESS_SECRET usa el valor de ejemplo en producción',
      );
    }
    if (env.CORS_ORIGINS.includes('*')) {
      throw new Error('Configuración de entorno inválida: CORS_ORIGINS no admite "*" en producción');
    }
  }
  return env;
}
