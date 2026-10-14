import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { normalizeEmail } from '../../common/utils/email.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class GrantDto {
  @IsString()
  @Matches(/^[A-Z_]{3,50}$/, { message: 'roleCode inválido' })
  roleCode!: string;

  /** Solo para administradores de plataforma; una clínica asigna siempre dentro de la suya. */
  @IsOptional()
  @IsUUID()
  clinicId?: string;

  /** Omitido = toda la clínica (o la sede fija del contexto del administrador). */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class CreateUserDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Contraseña inicial. No hay flujo de recuperación todavía (ver README). */
  @IsString()
  @MinLength(12, { message: 'La contraseña debe tener al menos 12 caracteres' })
  @MaxLength(128)
  password!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  /** Obligatoria para administradores de clínica; opcional para plataforma. */
  @IsOptional()
  @ValidateNested()
  @Type(() => GrantDto)
  assignment?: GrantDto;
}

export class CreateAssignmentDto extends GrantDto {
  @IsUUID()
  userId!: string;
}
