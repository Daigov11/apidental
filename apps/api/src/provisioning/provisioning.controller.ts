import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { CreateProvisioningRecordDto, RevokeProvisioningRecordDto } from './dto/provisioning.dto.js';
import { ProvisioningService } from './provisioning.service.js';

/**
 * Registro formal del aprovisionamiento del primer Director Clínico. Lo registra el administrador de
 * la clínica (nunca la plataforma), con reautenticación. Es declarativo: ver PROVISIONING_NOTICE.
 */
@Controller('provisioning-records')
export class ProvisioningController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Post()
  @RequirePermissions('provisioning:record')
  create(@CurrentPrincipal() actor: AuthPrincipal, @Body() dto: CreateProvisioningRecordDto, @Meta() meta: RequestMeta) {
    return this.provisioning.record(actor, dto, meta);
  }

  @Get()
  @RequirePermissions('provisioning:read')
  list(@CurrentPrincipal() actor: AuthPrincipal) {
    return this.provisioning.list(actor);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermissions('provisioning:record')
  revoke(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RevokeProvisioningRecordDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.provisioning.revoke(actor, id, dto.reason, meta);
  }
}
