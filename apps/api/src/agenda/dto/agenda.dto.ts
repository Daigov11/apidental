import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;
const REASON_MSG = 'El motivo debe tener al menos 3 caracteres';

// ------------------------------------------------------------------ catálogos
export class CreateRoomDto {
  @IsUUID() branchId!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name!: string;
}
export class UpdateRoomDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class CreateSpecialtyDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name!: string;
}
export class UpdateSpecialtyDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class CreateServiceDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsUUID() specialtyId?: string;
  @IsInt() @Min(5) @Max(480) durationMinutes!: number;
}
export class UpdateServiceDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsUUID() specialtyId?: string | null;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMinutes?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class SetDentistSpecialtiesDto {
  @IsArray() @ArrayMaxSize(20) @IsUUID(undefined, { each: true }) specialtyIds!: string[];
}

export class BranchQuery {
  @IsOptional() @IsUUID() branchId?: string;
}

// ------------------------------------------------------------------- horarios
export class CreateScheduleRuleDto {
  @IsUUID() branchId!: string;
  @IsUUID() dentistUserId!: string;
  @IsInt() @Min(1) @Max(7) weekday!: number;
  @Matches(HM, { message: 'start debe tener el formato HH:MM' }) start!: string;
  @Matches(HM, { message: 'end debe tener el formato HH:MM' }) end!: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @Matches(DATE) validFrom?: string;
  @IsOptional() @Matches(DATE) validUntil?: string;
}
export class ListSchedulesQuery {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() dentistUserId?: string;
}
export class DeactivateRuleDto {
  @Transform(trim) @IsString() @MinLength(3, { message: REASON_MSG }) @MaxLength(300) reason!: string;
}

export class CreateBlockDto {
  @IsUUID() branchId!: string;
  @IsOptional() @IsUUID() dentistUserId?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsString() @MaxLength(40) startsAt!: string;
  @IsString() @MaxLength(40) endsAt!: string;
  @Transform(trim) @IsString() @MinLength(3, { message: REASON_MSG }) @MaxLength(300) reason!: string;
}
export class ReleaseBlockDto {
  @Transform(trim) @IsString() @MinLength(3, { message: REASON_MSG }) @MaxLength(300) reason!: string;
}

// ---------------------------------------------------------------- disponibilidad
export class AvailabilityQuery {
  @IsUUID() branchId!: string;
  @Matches(DATE) from!: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(480) durationMinutes?: number;
  @IsOptional() @IsUUID() dentistUserId?: string;
  @IsOptional() @IsUUID() roomId?: string;
  /// Cita que se está reprogramando: sus propios huecos no cuentan como ocupados.
  @IsOptional() @IsUUID() ignoreAppointmentId?: string;
}

export class CalendarQuery {
  @IsUUID() branchId!: string;
  @Matches(DATE) from!: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() dentistUserId?: string;
  @IsOptional() @IsUUID() roomId?: string;
}

// ------------------------------------------------------------------------ citas
export class CreateAppointmentDto {
  @IsUUID() patientId!: string;
  @IsUUID() branchId!: string;
  @IsUUID() serviceId!: string;
  @IsUUID() dentistUserId!: string;
  @IsString() @MaxLength(40) startsAt!: string;
  /// Si se omite, el sistema elige el primer consultorio libre (el habitual del odontólogo primero).
  @IsOptional() @IsUUID() roomId?: string;
  /// Si se omite, la duración del servicio.
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMinutes?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) notes?: string;
}

export class VersionDto {
  @IsInt() @Min(1) expectedVersion!: number;
}
export class RescheduleAppointmentDto extends VersionDto {
  @Transform(trim) @IsString() @MinLength(3, { message: REASON_MSG }) @MaxLength(300) reason!: string;
  @IsOptional() @IsString() @MaxLength(40) startsAt?: string;
  @IsOptional() @IsUUID() dentistUserId?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMinutes?: number;
}
export class ReasonVersionDto extends VersionDto {
  @Transform(trim) @IsString() @MinLength(3, { message: REASON_MSG }) @MaxLength(300) reason!: string;
}
export class UpdateNotesDto extends VersionDto {
  @Transform(trim) @IsString() @MaxLength(300) notes!: string;
}

export enum AppointmentStatusDto { RESERVED = 'RESERVED', CONFIRMED = 'CONFIRMED', ATTENDED = 'ATTENDED', CANCELLED = 'CANCELLED', NO_SHOW = 'NO_SHOW' }

export class ListAppointmentsQuery extends PaginationQuery {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() dentistUserId?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsEnum(AppointmentStatusDto) status?: AppointmentStatusDto;
}
