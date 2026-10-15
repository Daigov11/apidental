import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { ConsentsService } from './consents.service.js';
import { CreateConsentDto, RevokeConsentDto } from './dto/consent.dto.js';

@Controller('patients/:id/consents')
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @Get()
  @RequirePermissions('consent:read')
  list(@CurrentPrincipal() a: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Meta() meta: RequestMeta) {
    return this.consents.list(a, id, meta);
  }

  @Post()
  @RequirePermissions('consent:write')
  grant(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateConsentDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.consents.grant(a, id, dto, meta);
  }

  @Post(':consentId/revoke')
  @HttpCode(200)
  @RequirePermissions('consent:write')
  revoke(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('consentId', new ParseUUIDPipe()) consentId: string,
    @Body() dto: RevokeConsentDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.consents.revoke(a, id, consentId, dto, meta);
  }
}
