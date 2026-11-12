import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

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

/** Asigna un rol a un usuario EXISTENTE (alta directa: CreateUserDto; o por invitación). */
export class CreateAssignmentDto extends GrantDto {
  @IsUUID()
  userId!: string;
}

/** Alta directa de un usuario del sistema por un administrador, con su rol en la clínica. */
export class CreateUserDto extends GrantDto {
  @Transform(trim) @IsEmail({}, { message: 'Correo inválido' }) @MaxLength(254) email!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  /** Opcional: sin contraseña, el sistema genera una y la devuelve UNA sola vez. */
  @IsOptional() @IsString() @MinLength(12, { message: 'La contraseña debe tener al menos 12 caracteres' }) @MaxLength(128) password?: string;
}

/** Nueva contraseña para otro usuario. Sin contraseña, el sistema genera una y la devuelve UNA sola vez. */
export class ResetPasswordDto {
  @IsOptional() @IsString() @MinLength(12, { message: 'La contraseña debe tener al menos 12 caracteres' }) @MaxLength(128) password?: string;
}
