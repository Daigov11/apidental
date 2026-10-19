import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { PaginationQuery } from '../common/dto/pagination.dto.js';
import { RequiredReason, trim } from '../patients/dto/common.js';

const emptyToUndefined = ({ value }: { value: unknown }) => {
  const v = typeof value === 'string' ? value.trim() : value;
  return v === '' ? undefined : v;
};

export class PrescriptionItemDto {
  @Transform(trim) @IsString() @MinLength(2, { message: 'Indique el medicamento' }) @MaxLength(200)
  medication!: string;

  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(120)
  dose?: string;

  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(120)
  frequency?: string;

  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(120)
  duration?: string;

  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(300)
  instructions?: string;
}

export class SavePrescriptionDto {
  @IsArray() @ArrayMinSize(1, { message: 'Agregue al menos un medicamento' }) @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => PrescriptionItemDto)
  items!: PrescriptionItemDto[];

  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(300)
  diagnosis?: string;

  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(1000)
  notes?: string;

  /** Solo al crear: vincula la receta a una atención del mismo paciente (opcional; la receta puede emitirse sin cita). */
  @IsOptional() @IsUUID()
  visitId?: string;
}

export class DeletePrescriptionDto {
  @RequiredReason()
  reason!: string;
}

export class EmailPrescriptionDto {
  /** Si falta, se usa el correo principal del paciente. */
  @IsOptional() @Transform(emptyToUndefined) @IsEmail({}, { message: 'Ingrese un correo válido' }) @MaxLength(254)
  to?: string;
}

export class ListPrescriptionsQuery {
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  includeDeleted?: boolean;
}

export class ListRecentPrescriptionsQuery extends PaginationQuery {}
