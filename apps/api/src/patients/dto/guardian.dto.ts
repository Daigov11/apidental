import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { RequiredReason, trim } from './common.js';
import { IdentifierTypeDto } from './patient.dto.js';

export enum GuardianRelationshipDto {
  MOTHER = 'MOTHER',
  FATHER = 'FATHER',
  LEGAL_GUARDIAN = 'LEGAL_GUARDIAN',
  GRANDPARENT = 'GRANDPARENT',
  SIBLING = 'SIBLING',
  OTHER = 'OTHER',
}

export class GuardianInput {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  firstName!: string;

  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  lastName!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(100)
  secondLastName?: string;

  @IsOptional() @IsEnum(IdentifierTypeDto)
  identifierType?: IdentifierTypeDto;

  @IsOptional() @IsString() @MaxLength(40)
  identifierNumber?: string;

  @IsOptional() @IsString() @MaxLength(40)
  mobile?: string;

  @IsOptional() @IsString() @MaxLength(254)
  email?: string;
}

export class LinkGuardianDto {
  /** Reutiliza un apoderado existente de la clínica (p. ej. hermanos)... */
  @IsOptional() @IsUUID()
  guardianId?: string;

  /** ...o crea uno nuevo. Debe indicarse exactamente uno de los dos. */
  @IsOptional() @ValidateNested() @Type(() => GuardianInput)
  guardian?: GuardianInput;

  @IsEnum(GuardianRelationshipDto)
  relationship!: GuardianRelationshipDto;

  @IsOptional() @IsBoolean()
  isPrimary?: boolean;

  @IsOptional() @IsBoolean()
  isLegalRepresentative?: boolean;
}

export class EndGuardianLinkDto {
  @RequiredReason()
  reason!: string;
}

export class SearchGuardiansQuery {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  search!: string;
}
