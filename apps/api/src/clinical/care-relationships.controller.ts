import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { CareRelationshipsService } from './care-relationships.service.js';
import {
  CreateCareRelationshipDto,
  ListCareRelationshipsQuery,
  RevokeCareRelationshipDto,
} from './dto/clinical.dto.js';

const uuid = () => new ParseUUIDPipe();

@Controller()
export class CareRelationshipsController {
  constructor(private readonly care: CareRelationshipsService) {}

  @Get('care-relationships')
  @RequirePermissions('care:assign')
  listClinic(
    @CurrentPrincipal() a: AuthPrincipal,
    @Query() q: ListCareRelationshipsQuery,
    @Meta() meta: RequestMeta,
  ) {
    return this.care.listClinic(a, q, q.limit, q.offset, meta);
  }

  @Get('patients/:id/care-relationships')
  @RequirePermissions('care:assign')
  list(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Query() q: ListCareRelationshipsQuery,
    @Meta() meta: RequestMeta,
  ) {
    return this.care.listForPatient(a, id, q.status, meta);
  }

  @Post('patients/:id/care-relationships')
  @RequirePermissions('care:assign')
  create(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: CreateCareRelationshipDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.care.create(a, id, dto, meta);
  }

  @Post('care-relationships/:relId/revoke')
  @HttpCode(200)
  @RequirePermissions('care:assign')
  revoke(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('relId', uuid()) relId: string,
    @Body() dto: RevokeCareRelationshipDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.care.revoke(a, relId, dto.reason, meta);
  }
}
