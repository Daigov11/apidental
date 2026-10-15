import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { DATE_ONLY, OptionalReason, RequiredReason, trim } from './common.js';

export enum IdentifierTypeDto {
  DNI = 'DNI',
  CE = 'CE',
  PASSPORT = 'PASSPORT',
}
export enum ContactTypeDto {
  MOBILE = 'MOBILE',
  PHONE = 'PHONE',
  EMAIL = 'EMAIL',
  ADDRESS = 'ADDRESS',
}
export enum SexDto {
  FEMALE = 'FEMALE',
  MALE = 'MALE',
  OTHER = 'OTHER',
}
export enum PatientStatusDto {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}


export class IdentifierInput {
  @IsEnum(IdentifierTypeDto)
  type!: IdentifierTypeDto;

  @IsString()
  @MaxLength(40)
  number!: string;
}

export class ContactInput {
  @IsEnum(ContactTypeDto)
  type!: ContactTypeDto;

  @IsString()
  @MaxLength(300)
  value!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class CreatePatientDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  firstName!: string;

  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  lastName!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(100)
  secondLastName?: string;

  /** YYYY-MM-DD. */
  @IsOptional() @Matches(DATE_ONLY, { message: 'birthDate debe tener el formato YYYY-MM-DD' })
  birthDate?: string;

  @IsOptional() @IsEnum(SexDto)
  sex?: SexDto;

  @IsOptional() @ValidateNested() @Type(() => IdentifierInput)
  identifier?: IdentifierInput;

  @IsOptional() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ContactInput)
  contacts?: ContactInput[];
}

export class UpdatePatientDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  firstName?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  lastName?: string;

  /** null borra el segundo apellido. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Transform(trim) @IsString() @MaxLength(100)
  secondLastName?: string | null;

  @IsOptional() @Matches(DATE_ONLY, { message: 'birthDate debe tener el formato YYYY-MM-DD' })
  birthDate?: string;

  @IsOptional() @IsEnum(SexDto)
  sex?: SexDto;

  @OptionalReason()
  reason?: string;
}

export class StatusChangeDto {
  @RequiredReason()
  reason!: string;
}

/** Datos con los que se busca un posible duplicado antes (o después) de crear. */
export class DuplicateCheckDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100)
  firstName?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(100)
  lastName?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(100)
  secondLastName?: string;

  @IsOptional() @Matches(DATE_ONLY, { message: 'birthDate debe tener el formato YYYY-MM-DD' })
  birthDate?: string;

  @IsOptional() @ValidateNested() @Type(() => IdentifierInput)
  identifier?: IdentifierInput;

  @IsOptional() @IsString() @MaxLength(40)
  mobile?: string;

  @IsOptional() @IsString() @MaxLength(254)
  email?: string;
}

export class SearchPatientsQuery extends PaginationQuery {
  @IsOptional() @IsString() @MaxLength(40)
  identifier?: string;

  @IsOptional() @IsEnum(IdentifierTypeDto)
  identifierType?: IdentifierTypeDto;

  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(254)
  email?: string;

  @IsOptional() @Matches(DATE_ONLY, { message: 'birthDate debe tener el formato YYYY-MM-DD' })
  birthDate?: string;

  @IsOptional() @IsEnum(PatientStatusDto)
  status?: PatientStatusDto;
}

export class SetIdentifierDto extends IdentifierInput {
  /** Obligatorio al reemplazar un identificador existente. */
  @OptionalReason()
  reason?: string;
}

export class ChangeContactDto {
  @IsString() @MaxLength(300)
  value!: string;

  /** Obligatorio para celular y correo. */
  @OptionalReason()
  reason?: string;
}

export class RetireContactDto {
  /** Obligatorio para celular y correo. */
  @OptionalReason()
  reason?: string;
}

export class PatientIdParam {
  @IsUUID()
  id!: string;
}
