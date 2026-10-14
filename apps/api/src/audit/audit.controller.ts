import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { PaginationQuery } from '../common/dto/pagination.dto.js';
import { AuditService } from './audit.service.js';

class AuditQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Plataforma ve todo; una clínica solo su propia auditoría. */
  @Get()
  @RequirePermissions('audit:read')
  list(@CurrentPrincipal() principal: AuthPrincipal, @Query() query: AuditQuery) {
    const clinicId = principal.context?.clinicId ?? null;
    return this.audit.list({
      clinicId,
      action: query.action,
      userId: query.userId,
      limit: query.limit,
      offset: query.offset,
    });
  }
}
