import { IsOptional, IsUUID } from 'class-validator';

/**
 * clinicId omitido/null = contexto de plataforma.
 * branchId omitido/null = contexto de toda la clínica.
 */
export class SelectContextDto {
  @IsOptional()
  @IsUUID()
  clinicId?: string | null;

  @IsOptional()
  @IsUUID()
  branchId?: string | null;
}
