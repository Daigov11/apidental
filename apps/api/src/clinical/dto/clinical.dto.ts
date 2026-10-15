import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { MIN_JUSTIFICATION_LENGTH } from '../clinical.constants.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export enum ClinicalAccessCategoryDto {
  CONTINUITY_OF_CARE = 'CONTINUITY_OF_CARE',
  QUALITY_AUDIT = 'QUALITY_AUDIT',
  LEGAL_REQUEST = 'LEGAL_REQUEST',
  OTHER = 'OTHER',
}

/** Justificación para leer a UN paciente sin relación asistencial (`clinical:read_all`). */
export class RequestClinicalAccessDto {
  @IsEnum(ClinicalAccessCategoryDto, {
    message: 'category no es una categoría válida',
  })
  category!: ClinicalAccessCategoryDto;

  /** Motivo concreto. Va a la auditoría: no incluya datos clínicos del paciente. */
  @Transform(trim)
  @IsString()
  @MinLength(MIN_JUSTIFICATION_LENGTH, {
    message: `El motivo debe tener al menos ${MIN_JUSTIFICATION_LENGTH} caracteres`,
  })
  @MaxLength(500)
  reason!: string;

  /** Prueba de reautenticación (CLINICAL_READ_ALL) emitida para ESTE paciente. */
  @IsString()
  @MaxLength(100)
  reauthToken!: string;
}

export class CreateCareRelationshipDto {
  @IsUUID()
  dentistUserId!: string;

  /** Sede de origen de la relación; omitida = toda la clínica (salvo que su contexto esté limitado a una sede). */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class RevokeCareRelationshipDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'El motivo debe tener al menos 3 caracteres' })
  @MaxLength(300)
  reason!: string;
}

export class ListCareRelationshipsQuery extends PaginationQuery {
  @IsOptional()
  @IsEnum({ ACTIVE: 'ACTIVE', ENDED: 'ENDED' })
  status?: 'ACTIVE' | 'ENDED';

  @IsOptional()
  @IsUUID()
  dentistUserId?: string;
}
