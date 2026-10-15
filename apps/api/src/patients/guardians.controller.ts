import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { EndGuardianLinkDto, LinkGuardianDto, SearchGuardiansQuery } from './dto/guardian.dto.js';
import { GuardiansService } from './guardians.service.js';

@Controller()
export class GuardiansController {
  constructor(private readonly guardians: GuardiansService) {}

  @Get('guardians')
  @RequirePermissions('patient:read')
  search(@CurrentPrincipal() a: AuthPrincipal, @Query() q: SearchGuardiansQuery, @Meta() meta: RequestMeta) {
    return this.guardians.search(a, q.search, meta);
  }

  @Get('patients/:id/guardians')
  @RequirePermissions('patient:read')
  list(@CurrentPrincipal() a: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Meta() meta: RequestMeta) {
    return this.guardians.listForPatient(a, id, meta);
  }

  @Post('patients/:id/guardians')
  @RequirePermissions('patient:write')
  link(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: LinkGuardianDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.guardians.link(a, id, dto, meta);
  }

  @Post('patients/:id/guardians/:linkId/end')
  @HttpCode(200)
  @RequirePermissions('patient:write')
  end(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('linkId', new ParseUUIDPipe()) linkId: string,
    @Body() dto: EndGuardianLinkDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.guardians.endLink(a, id, linkId, dto, meta);
  }
}
