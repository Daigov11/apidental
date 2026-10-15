import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { normalizeEmail } from '../../common/utils/email.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateInvitationDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/^[A-Z_]{3,50}$/, { message: 'roleCode inválido' })
  roleCode!: string;

  /** Solo la plataforma lo indica (clínica del primer administrador); una clínica invita siempre a la suya. */
  @IsOptional()
  @IsUUID()
  clinicId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Solo para el PRIMER Director Clínico: registro formal de aprovisionamiento vigente. */
  @IsOptional()
  @IsUUID()
  provisioningRecordId?: string;

  /** Prueba de reautenticación (AUTHORIZE_DIRECTOR_PROVISIONING, objeto = clínica). Obligatoria para el Director. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reauthToken?: string;
}

export class RevokeInvitationDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'El motivo debe tener al menos 3 caracteres' })
  @MaxLength(300)
  reason!: string;
}

export class ListInvitationsQuery extends PaginationQuery {
  @IsOptional()
  @Matches(/^(PENDING|ACCEPTED|REVOKED|EXPIRED)$/)
  status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
}

export class PreviewInvitationDto {
  @IsString()
  @MaxLength(100)
  token!: string;
}

export class AcceptInvitationDto {
  @IsString()
  @MaxLength(100)
  token!: string;

  /**
   * Cuenta nueva: la contraseña que ELIGE la persona invitada (12-128 caracteres).
   * Cuenta existente: su contraseña actual (la invitación nunca la cambia).
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  /** Obligatorios solo si se crea una cuenta nueva; se ignoran si la cuenta ya existe. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;
}
