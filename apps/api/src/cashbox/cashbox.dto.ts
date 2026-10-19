import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../common/dto/pagination.dto.js';
import { DATE_ONLY, RequiredReason, trim } from '../patients/dto/common.js';

export const MAX_CENTS = 100_000_000;
const empty = ({ value }: { value: unknown }) => {
  const v = typeof value === 'string' ? value.trim() : value;
  return v === '' ? undefined : v;
};
const bool = ({ value }: { value: unknown }) => value === 'true' || value === true;

export enum CashFlowDto { INCOME = 'INCOME', EXPENSE = 'EXPENSE' }
export enum CashAccountKindDto { CASH = 'CASH', CARD = 'CARD', YAPE_PLIN = 'YAPE_PLIN', TRANSFER = 'TRANSFER', OTHER = 'OTHER' }

export class CreateMovementDto {
  @IsEnum(CashFlowDto, { message: 'Indique si es un ingreso o un egreso' }) flow!: CashFlowDto;
  @IsUUID() accountId!: string;
  @IsUUID(undefined, { message: 'Elija el tipo de operación' }) categoryId!: string;
  @Transform(trim) @IsString() @MinLength(3, { message: 'Describa el movimiento (mínimo 3 caracteres)' }) @MaxLength(200) description!: string;
  @IsOptional() @Transform(empty) @IsString() @MaxLength(40) operationNumber?: string;
  @IsInt({ message: 'Ingrese un monto válido' }) @Min(1, { message: 'El monto debe ser mayor que cero' }) @Max(MAX_CENTS, { message: 'El monto supera el máximo permitido' }) amountCents!: number;
  /** Instante del movimiento; por omisión, ahora. No puede ser futuro ni anterior a la apertura de la caja. */
  @IsOptional() @IsISO8601() occurredAt?: string;
  /** Generada al abrir el formulario: un reenvío (doble clic, reintento de red) no duplica el movimiento. */
  @IsUUID() requestKey!: string;
}

export class VoidMovementDto { @RequiredReason() reason!: string }

export class OpeningDto {
  @IsUUID() accountId!: string;
  @IsInt() @Min(0) @Max(MAX_CENTS) amountCents!: number;
}
export class OpenSessionDto {
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => OpeningDto) openings?: OpeningDto[];
  @IsOptional() @Transform(empty) @IsString() @MaxLength(300) notes?: string;
}

export class CountDto {
  @IsUUID() accountId!: string;
  @IsInt() @Min(0) @Max(MAX_CENTS) countedCents!: number;
}
export class CloseSessionDto {
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => CountDto) counts!: CountDto[];
  @IsOptional() @Transform(empty) @IsString() @MaxLength(300) notes?: string;
}

export class SaveAccountDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsEnum(CashAccountKindDto) kind!: CashAccountKindDto;
  @IsOptional() @IsBoolean() allowNegative?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class SaveCategoryDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name!: string;
  /** Solo al crear. */
  @IsOptional() @IsEnum(CashFlowDto) flow?: CashFlowDto;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ListMovementsQuery extends PaginationQuery {
  @IsOptional() @Matches(DATE_ONLY) from?: string;
  @IsOptional() @Matches(DATE_ONLY) to?: string;
  @IsOptional() @IsEnum(CashFlowDto) flow?: CashFlowDto;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() includeVoided?: boolean;
}

export class ReportQuery {
  @Matches(DATE_ONLY, { message: 'Indique la fecha inicial' }) from!: string;
  @Matches(DATE_ONLY, { message: 'Indique la fecha final' }) to!: string;
}
