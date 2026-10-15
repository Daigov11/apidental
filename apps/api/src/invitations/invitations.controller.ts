import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequireAnyPermission, RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import {
  AcceptInvitationDto,
  CreateInvitationDto,
  ListInvitationsQuery,
  PreviewInvitationDto,
  RevokeInvitationDto,
} from './dto/invitation.dto.js';
import { InvitationsService } from './invitations.service.js';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /**
   * Crea una invitación de un solo uso. El enlace NUNCA vuelve en la respuesta en producción: solo lo
   * recibe el destinatario por el canal configurado (en desarrollo/pruebas se devuelve como devAcceptUrl).
   * El permiso exacto depende del rol invitado; el servicio lo concreta.
   */
  @Post()
  @RequireAnyPermission('invitation:manage', 'director:manage')
  create(@CurrentPrincipal() actor: AuthPrincipal, @Body() dto: CreateInvitationDto, @Meta() meta: RequestMeta) {
    return this.invitations.create(actor, dto, meta);
  }

  @Get()
  @RequirePermissions('invitation:read')
  list(@CurrentPrincipal() actor: AuthPrincipal, @Query() q: ListInvitationsQuery) {
    return this.invitations.list(actor, q);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequireAnyPermission('invitation:manage', 'director:manage', 'provisioning:record')
  revoke(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RevokeInvitationDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.invitations.revoke(actor, id, dto.reason, meta);
  }

  /** Genera un enlace nuevo (el anterior deja de valer) y lo entrega de nuevo. */
  @Post(':id/resend')
  @HttpCode(200)
  @RequireAnyPermission('invitation:manage', 'director:manage', 'provisioning:record')
  resend(@CurrentPrincipal() actor: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Meta() meta: RequestMeta) {
    return this.invitations.resend(actor, id, meta);
  }

  // ---- públicos: los usa quien recibe el enlace (límite estricto por IP) ----

  @Public()
  @Post('preview')
  @HttpCode(200)
  preview(@Body() dto: PreviewInvitationDto) {
    return this.invitations.preview(dto.token);
  }

  /** Acepta la invitación. Cuenta nueva: la persona define su contraseña. Cuenta existente: usa la suya. */
  @Public()
  @Post('accept')
  @HttpCode(200)
  accept(@Body() dto: AcceptInvitationDto, @Meta() meta: RequestMeta) {
    return this.invitations.accept(dto, meta);
  }
}
