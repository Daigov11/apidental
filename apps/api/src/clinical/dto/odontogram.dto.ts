import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ReauthInput } from './care.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const ETAG = /^\d{1,6}\.\d{1,6}$/;
const REASON_MSG = 'El motivo debe tener al menos 3 caracteres';

export enum DentitionDto {
  PERMANENT = 'PERMANENT',
  PRIMARY = 'PRIMARY',
  MIXED = 'MIXED',
}
/** Para qué se abre un borrador nuevo sobre la última versión guardada. */
export enum OdontogramPurposeDto {
  UPDATE = 'UPDATE',
  CORRECTION = 'CORRECTION',
  RECTIFICATION = 'RECTIFICATION',
}

export class StartOdontogramDraftDto {
  /** Omitido en el primer odontograma. Corrección y rectificación exigen motivo. */
  @IsOptional() @IsEnum(OdontogramPurposeDto) purpose?: OdontogramPurposeDto;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason?: string;
  @IsOptional() @IsEnum(DentitionDto) dentition?: DentitionDto;
}

/** Reemplaza la estructura completa del borrador (el panel envía el documento tal como lo dejó el usuario). */
export class SaveOdontogramDraftDto {
  @IsObject() data!: Record<string, unknown>;
  @IsOptional() @IsEnum(DentitionDto) dentition?: DentitionDto;
  @IsString()
  @Matches(ETAG, { message: 'expectedEtag no es válido' })
  expectedEtag!: string;
}

/** Guardar la versión (inmutable). La reautenticación solo se exige si el borrador es una corrección o rectificación. */
export class CloseOdontogramDto extends ReauthInput {
  @IsString()
  @Matches(ETAG, { message: 'expectedEtag no es válido' })
  expectedEtag!: string;
}

export class DiscardOdontogramDto {
  @IsString()
  @Matches(ETAG, { message: 'expectedEtag no es válido' })
  expectedEtag!: string;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
}

export class MarkOdontogramErrorDto extends ReauthInput {
  @IsString()
  @Matches(ETAG, { message: 'expectedEtag no es válido' })
  expectedEtag!: string;
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: REASON_MSG })
  @MaxLength(300)
  reason!: string;
}

export class ExportOdontogramQuery {
  @IsOptional() @IsEnum({ pdf: 'pdf', svg: 'svg' }) format?: 'pdf' | 'svg';
  /** Versión guardada a exportar; por omisión, la vigente (la última guardada que no se registró por error). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  version?: number;
}
