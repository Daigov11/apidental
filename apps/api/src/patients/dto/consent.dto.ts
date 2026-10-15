import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { RequiredReason, trim } from './common.js';

export enum ConsentTypeDto {
  CLINICAL = 'CLINICAL',
  LOYALTY = 'LOYALTY',
  MARKETING = 'MARKETING',
}
export enum ConsentGrantedByDto {
  PATIENT = 'PATIENT',
  GUARDIAN = 'GUARDIAN',
}

export class CreateConsentDto {
  @IsEnum(ConsentTypeDto)
  type!: ConsentTypeDto;

  /** Nombre del documento que se firmó/aceptó (texto libre; formatos oficiales: por validar). */
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  documentTitle!: string;

  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  documentVersion!: string;

  /** Fecha y hora en que se otorgó (ISO 8601). Por defecto, ahora. */
  @IsOptional() @IsDateString()
  grantedAt?: string;

  @IsEnum(ConsentGrantedByDto)
  grantedBy!: ConsentGrantedByDto;

  /** Obligatorio cuando lo otorga un apoderado (y siempre si el paciente es menor). */
  @IsOptional() @IsUUID()
  guardianId?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  notes?: string;
}

export class RevokeConsentDto {
  @RequiredReason()
  reason!: string;
}
