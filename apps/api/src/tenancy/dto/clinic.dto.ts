import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export class CreateClinicDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  legalName?: string;

  /** RUC peruano de 11 dígitos; la validación SUNAT real queda fuera de este incremento. */
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'ruc debe tener 11 dígitos' })
  ruc?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  brandDisplayName?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  brandLogoUrl?: string;

  @IsOptional()
  @Matches(COLOR, { message: 'brandPrimaryColor debe ser #RRGGBB o #RRGGBBAA' })
  brandPrimaryColor?: string;

  @IsOptional()
  @Matches(COLOR, { message: 'brandSecondaryColor debe ser #RRGGBB o #RRGGBBAA' })
  brandSecondaryColor?: string;
}
