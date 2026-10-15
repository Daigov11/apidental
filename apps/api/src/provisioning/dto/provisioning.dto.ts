import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { normalizeEmail } from '../../common/utils/email.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export enum AuthorizerDocumentType {
  DNI = 'DNI',
  CE = 'CE',
  PASSPORT = 'PASSPORT',
  RUC = 'RUC',
}

/**
 * Registro formal de la autorización de la clínica para designar a su primer Director Clínico.
 * LIMITACIÓN: sin firma ni flujo contractual integrado, esto es una declaración asentada por el
 * administrador de la clínica; el sistema NO verifica la autenticidad del documento citado.
 */
export class CreateProvisioningRecordDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200)
  designeeName!: string;

  /** La invitación del Director solo puede dirigirse a este correo. */
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail() @MaxLength(254)
  designeeEmail!: string;

  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200)
  authorizedByName!: string;

  @Transform(trim) @IsString() @MinLength(3) @MaxLength(120)
  authorizedByPosition!: string;

  @IsEnum(AuthorizerDocumentType)
  authorizedByDocumentType!: AuthorizerDocumentType;

  @IsString() @MaxLength(20)
  authorizedByDocumentNumber!: string;

  /** Identificación del documento que respalda la autorización (acta, poder, carta). */
  @Transform(trim) @IsString() @MinLength(5) @MaxLength(200)
  authorizationReference!: string;

  /** Fecha del documento (YYYY-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'authorizationDate debe tener el formato YYYY-MM-DD' })
  authorizationDate!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  notes?: string;

  /** Prueba de reautenticación (AUTHORIZE_DIRECTOR_PROVISIONING, objeto = clínica). */
  @IsString() @MaxLength(100)
  reauthToken!: string;
}

export class RevokeProvisioningRecordDto {
  @Transform(trim) @IsString() @MinLength(3, { message: 'El motivo debe tener al menos 3 caracteres' }) @MaxLength(300)
  reason!: string;
}
