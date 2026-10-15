import { Transform, Type } from 'class-transformer';
import { Equals, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;

export class PublicAvailabilityQuery {
  @IsUUID() branchId!: string;
  @IsUUID() serviceId!: string;
  @Matches(DATE) from!: string;
  @IsOptional() @Matches(DATE) to?: string;
}

/** Solicitud pública. Cualquier campo desconocido se rechaza (whitelist global). */
export class CreateBookingRequestDto {
  @IsUUID() branchId!: string;
  @IsUUID() serviceId!: string;
  @Matches(DATE, { message: 'La fecha debe tener el formato YYYY-MM-DD' }) date!: string;
  @Matches(HM, { message: 'La hora debe tener el formato HH:MM' }) time!: string;

  @Transform(trim) @IsString() @MinLength(2, { message: 'Escriba sus nombres' }) @MaxLength(100) firstName!: string;
  @Transform(trim) @IsString() @MinLength(2, { message: 'Escriba su apellido paterno' }) @MaxLength(100) lastName!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) secondLastName?: string;

  @IsOptional() @IsIn(['DNI', 'CE', 'PASSPORT']) documentType?: 'DNI' | 'CE' | 'PASSPORT';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) documentNumber?: string;

  @Transform(trim) @IsString() @MaxLength(20) mobile!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(254) email?: string;
  /** Nota administrativa. No debe contener datos clínicos. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) notes?: string;

  @IsBoolean() @Equals(true, { message: 'Debe aceptar el aviso de privacidad' }) acceptPrivacy!: boolean;
  /** Campo señuelo: las personas no lo ven; si viene con texto, se trata como automático. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export enum RequestStatusFilter {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  ALL = 'ALL',
}

export class ListBookingRequestsQuery {
  @IsOptional() @IsEnum(RequestStatusFilter) status?: RequestStatusFilter;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class AcceptBookingRequestDto {
  @IsUUID() patientId!: string;
  @IsUUID() dentistUserId!: string;
  @IsString() startsAt!: string;
  @IsOptional() @IsUUID() roomId?: string;
}

export class RejectBookingRequestDto {
  @Transform(trim) @IsString() @MinLength(3, { message: 'El motivo debe tener al menos 3 caracteres' }) @MaxLength(300) reason!: string;
}
