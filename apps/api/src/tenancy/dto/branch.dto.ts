import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateBranchDto {
  /** Solo lo usa el administrador de plataforma; una clínica crea sedes en su propia clínica. */
  @IsOptional()
  @IsUUID()
  clinicId?: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  address?: string;
}

export class ListBranchesQuery extends PaginationQuery {
  @IsOptional()
  @IsUUID()
  clinicId?: string;
}
