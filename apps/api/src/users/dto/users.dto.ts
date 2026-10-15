import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class GrantDto {
  @IsString()
  @Matches(/^[A-Z_]{3,50}$/, { message: 'roleCode inválido' })
  roleCode!: string;

  /** Solo para administradores de plataforma; una clínica asigna siempre dentro de la suya. */
  @IsOptional()
  @IsUUID()
  clinicId?: string;

  /** Omitido = toda la clínica (o la sede fija del contexto del administrador). */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** Asigna un rol a un usuario EXISTENTE. Los usuarios nuevos solo se incorporan por invitación. */
export class CreateAssignmentDto extends GrantDto {
  @IsUUID()
  userId!: string;
}
