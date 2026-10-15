import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { normalizeEmail } from '../../common/utils/email.js';

export class RequestPasswordRecoveryDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ValidateRecoveryTokenDto {
  @IsString()
  @MaxLength(100)
  token!: string;
}

export class ConfirmPasswordRecoveryDto {
  @IsString()
  @MaxLength(100)
  token!: string;

  /** La contraseña que ELIGE la persona (política: 12-128 caracteres, distinta de su correo y de la actual). */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  newPassword!: string;
}
