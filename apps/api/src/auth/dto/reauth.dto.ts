import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export enum ReauthPurposeDto {
  CLOSE_CLINICAL_NOTE = 'CLOSE_CLINICAL_NOTE',
  CORRECT_CLINICAL_NOTE = 'CORRECT_CLINICAL_NOTE',
  MARK_CLINICAL_NOTE_ERROR = 'MARK_CLINICAL_NOTE_ERROR',
  CLINICAL_READ_ALL = 'CLINICAL_READ_ALL',
  AUTHORIZE_DIRECTOR_PROVISIONING = 'AUTHORIZE_DIRECTOR_PROVISIONING',
}

export class ReauthenticateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  /** Para qué se reautentica. La prueba solo sirve para ESE propósito. */
  @IsEnum(ReauthPurposeDto)
  purpose!: ReauthPurposeDto;

  /** Objeto sobre el que se autoriza (p. ej. la clínica o la nota). La prueba solo sirve para ese objeto. */
  @IsOptional()
  @IsUUID()
  targetId?: string;
}
