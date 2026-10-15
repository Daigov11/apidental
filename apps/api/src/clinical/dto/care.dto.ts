import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const REASON_MSG = 'El motivo debe tener al menos 3 caracteres';

// ------------------------------------------------------------------ catálogo de procedimientos

export class CreateProcedureDefinitionDto {
  /** Código interno de la clínica (se guarda en mayúsculas). No es un nomenclador oficial. */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/, {
    message: 'code admite letras, números, "_", "." y "-" (hasta 40)',
  })
  code!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string;
  /** Si es verdadero, cerrar un procedimiento de este tipo exige consentimiento clínico vigente del paciente. */
  @IsOptional() @IsBoolean() requiresClinicalConsent?: boolean;
}

export class UpdateProcedureDefinitionDto {
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
  @MaxLength(160)
  name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) description?:
    string | null;
  @IsOptional() @IsBoolean() requiresClinicalConsent?: boolean;
}

export class DefinitionTransitionDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
}

export class ListDefinitionsQuery extends PaginationQuery {
  @IsOptional() @IsEnum({ ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' }) status?:
    'ACTIVE' | 'INACTIVE';
}

// ------------------------------------------------------------------------------ visitas

export class OpenVisitDto {
  /** Motivo ADMINISTRATIVO (p. ej. "control"). No incluya datos clínicos. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason?: string;
}

export class VisitTransitionDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class CancelVisitDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
}

export class ListVisitsQuery extends PaginationQuery {
  @IsOptional()
  @IsEnum({ OPEN: 'OPEN', CLOSED: 'CLOSED', CANCELLED: 'CANCELLED' })
  status?: 'OPEN' | 'CLOSED' | 'CANCELLED';
}

// ------------------------------------------------------------------------- diagnósticos

export enum CertaintyDto {
  PRESUMPTIVE = 'PRESUMPTIVE',
  DEFINITIVE = 'DEFINITIVE',
}

/** Diagnóstico DECLARADO por el profesional (texto libre). No es una recomendación ni dispara decisiones automáticas. */
export class CreateDiagnosisDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  description!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) code?: string;
  @IsEnum(CertaintyDto) certainty!: CertaintyDto;
  /** Opcional en el alta; obligatorio en todo cambio posterior. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason?: string;
}

export class ChangeDiagnosisDto {
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
  @MaxLength(500)
  description?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) code?:
    string | null;
  @IsOptional() @IsEnum(CertaintyDto) certainty?: CertaintyDto;
}

export class ListDiagnosesQuery extends PaginationQuery {
  @IsOptional() @IsUUID() visitId?: string;
  @IsOptional()
  @IsEnum({
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
    ENTERED_IN_ERROR: 'ENTERED_IN_ERROR',
  })
  status?: 'ACTIVE' | 'INACTIVE' | 'ENTERED_IN_ERROR';
}

// ----------------------------------------------------------------------- procedimientos

export class CreateProcedureDto {
  /** Tipo del catálogo de la clínica. */
  @IsUUID() definitionId!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) notes?: string;
  /** Fecha y hora (ISO 8601, no futura); por omisión, ahora. */
  @IsOptional() @IsString() @MaxLength(40) performedAt?: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason?: string;
}

export class ChangeProcedureDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) notes?:
    string | null;
  @IsOptional() @IsString() @MaxLength(40) performedAt?: string;
}

/** Cerrar el procedimiento: verifica el consentimiento clínico solo si su definición lo exige. */
export class CloseProcedureDto {
  @IsInt() @Min(1) expectedVersion!: number;
}

export class ProcedureTransitionDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
}

export class ListProceduresQuery extends PaginationQuery {
  @IsOptional() @IsUUID() visitId?: string;
  @IsOptional()
  @IsEnum({
    OPEN: 'OPEN',
    CLOSED: 'CLOSED',
    CANCELLED: 'CANCELLED',
    ENTERED_IN_ERROR: 'ENTERED_IN_ERROR',
  })
  status?: 'OPEN' | 'CLOSED' | 'CANCELLED' | 'ENTERED_IN_ERROR';
}
