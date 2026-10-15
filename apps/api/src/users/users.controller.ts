import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { PaginationQuery } from '../common/dto/pagination.dto.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { AssignmentsService } from './assignments.service.js';
import { UserStatusChangeDto } from './dto/user-status.dto.js';
import { CreateAssignmentDto } from './dto/users.dto.js';
import { UserStatusService } from './user-status.service.js';
import { UsersService } from './users.service.js';

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly assignments: AssignmentsService,
    private readonly status: UserStatusService,
  ) {}

  @Get('users')
  @RequirePermissions('user:read')
  list(@CurrentPrincipal() actor: AuthPrincipal, @Query() q: PaginationQuery) {
    return this.users.list(actor, q.limit, q.offset);
  }

  /**
   * Deshabilita la cuenta (nunca la elimina): revoca sesiones y refresh tokens, invalida pruebas de
   * reautenticación y aplica la regla de último administrador/Director. Exige motivo.
   */
  @Post('users/:id/disable')
  @HttpCode(200)
  @RequirePermissions('user:manage')
  disable(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UserStatusChangeDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.status.disable(actor, id, dto.reason, meta);
  }

  /** Reactivación explícita y auditada. No restaura sesiones: la persona debe iniciar sesión de nuevo. */
  @Post('users/:id/reactivate')
  @HttpCode(200)
  @RequirePermissions('user:manage')
  reactivate(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UserStatusChangeDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.status.reactivate(actor, id, dto.reason, meta);
  }

  @Get('roles')
  @RequirePermissions('role:read')
  roles(@CurrentPrincipal() actor: AuthPrincipal) {
    return this.users.listRoles(actor);
  }

  @Post('assignments')
  @RequirePermissions('assignment:manage')
  assign(@CurrentPrincipal() actor: AuthPrincipal, @Body() dto: CreateAssignmentDto, @Meta() meta: RequestMeta) {
    const { userId, ...grant } = dto;
    return this.assignments.create(actor, userId, grant, meta);
  }

  @Patch('assignments/:id/revoke')
  @HttpCode(200)
  @RequirePermissions('assignment:manage')
  revoke(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.assignments.revoke(actor, id, meta);
  }
}
