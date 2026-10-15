import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const REASON_MSG = 'El motivo debe tener al menos 3 caracteres';

export enum EntryKindDto {
  BACKGROUND = 'BACKGROUND',
  ALLERGY = 'ALLERGY',
}
export enum SeverityDto {
  NOT_SPECIFIED = 'NOT_SPECIFIED',
  MILD = 'MILD',
  MODERATE = 'MODERATE',
  SEVERE = 'SEVERE',
}
export enum SourceDto {
  PATIENT = 'PATIENT',
  GUARDIAN = 'GUARDIAN',
  DOCUMENT = 'DOCUMENT',
  PROFESSIONAL = 'PROFESSIONAL',
  OTHER = 'OTHER',
}
export enum RecordStatusDto {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ENTERED_IN_ERROR = 'ENTERED_IN_ERROR',
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Alta de un antecedente o alergia. Todo es texto estructurado de apoyo administrativo. */
export class CreateHistoryEntryDto {
  @IsEnum(EntryKindDto) kind!: EntryKindDto;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200) label!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) condition?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsEnum(SeverityDto) severity?: SeverityDto;
  /** Marcado como crítico, genera una alerta activa mientras el elemento esté activo. */
  @IsOptional() @IsBoolean() isCritical?: boolean;
  @IsOptional()
  @Matches(DATE, { message: 'onsetDate debe tener el formato YYYY-MM-DD' })
  onsetDate?: string;
  @IsEnum(SourceDto) source!: SourceDto;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  observations?: string;
  /** Opcional en el alta (la fuente sí es obligatoria); obligatorio en todo cambio posterior. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason?: string;
}

/**
 * Corrección o rectificación: crea una versión nueva. Los campos omitidos no cambian; `null` borra un campo opcional.
 * Debe cambiar al menos uno. `expectedVersion` evita pisar un cambio concurrente (409).
 */
export class ChangeHistoryEntryDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  label?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) condition?:
    string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) category?:
    string | null;
  @IsOptional() @IsEnum(SeverityDto) severity?: SeverityDto;
  @IsOptional() @IsBoolean() isCritical?: boolean;
  @IsOptional()
  @Matches(DATE, { message: 'onsetDate debe tener el formato YYYY-MM-DD' })
  onsetDate?: string | null;
  @IsOptional() @IsEnum(SourceDto) source?: SourceDto;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) observations?:
    string | null;
}

/** Desactivar, reactivar o marcar "registrado por error": solo versión esperada y motivo. */
export class TransitionDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
}

export class ListHistoryQuery extends PaginationQuery {
  @IsOptional() @IsEnum(EntryKindDto) kind?: EntryKindDto;
  @IsOptional() @IsEnum(RecordStatusDto) status?: RecordStatusDto;
}

// ----------------------------------------------------------------------------- alertas

export enum AlertSeverityDto {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

/** Alerta manual: informativa, con severidad, origen, vigencia opcional y motivo. No decide ni bloquea tratamientos. */
export class CreateAlertDto {
  @IsEnum(AlertSeverityDto) severity!: AlertSeverityDto;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) text!: string;
  @IsEnum(SourceDto) source!: SourceDto;
  /** Fecha y hora (ISO 8601) hasta la cual se muestra; omitida = sin vencimiento. */
  @IsOptional() @IsString() @MaxLength(40) expiresAt?: string;
  /** Opcional en el alta (la fuente sí es obligatoria); obligatorio en todo cambio posterior. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason?: string;
}

export class ChangeAlertDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
  @IsOptional() @IsEnum(AlertSeverityDto) severity?: AlertSeverityDto;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  text?: string;
  @IsOptional() @IsEnum(SourceDto) source?: SourceDto;
  @IsOptional() @IsString() @MaxLength(40) expiresAt?: string | null;
}

export class ListAlertsQuery {
  /** Solo para el nivel completo: incluye alertas inactivas, vencidas o registradas por error. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;
}

// ---------------------------------------------------------------- evaluación de alergias

export enum AllergyAssessmentStatusDto {
  NOT_ASKED = 'NOT_ASKED',
  NO_KNOWN_ALLERGIES = 'NO_KNOWN_ALLERGIES',
  ALLERGIES_RECORDED = 'ALLERGIES_RECORDED',
}

/**
 * Declara el estado de la evaluación de alergias. `ALLERGIES_RECORDED` NO se declara: lo deriva el sistema cuando hay
 * una alergia activa. `expectedVersion` = versión que el cliente leyó (0 si no existe aún). El motivo es obligatorio
 * desde la segunda versión.
 */
export class SetAllergyAssessmentDto {
  @IsEnum(AllergyAssessmentStatusDto) status!: AllergyAssessmentStatusDto;
  @IsEnum(SourceDto) source!: SourceDto;
  @IsInt() @Min(0) expectedVersion!: number;
  /** Fecha en que se consultó al paciente (YYYY-MM-DD, no futura); por omisión, hoy. */
  @IsOptional()
  @Matches(DATE, { message: 'assessedOn debe tener el formato YYYY-MM-DD' })
  assessedOn?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  observations?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason?: string;
}
