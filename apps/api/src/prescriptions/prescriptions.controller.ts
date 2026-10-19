import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import {
  DeletePrescriptionDto,
  EmailPrescriptionDto,
  ListPrescriptionsQuery,
  ListRecentPrescriptionsQuery,
  SavePrescriptionDto,
} from './prescriptions.dto.js';
import { PrescriptionsService } from './prescriptions.service.js';

const uuid = () => new ParseUUIDPipe();
// El permiso de ruta solo exige tener ALGÚN permiso clínico; la decisión real y su auditoría las toma ClinicalAccessService.
const READ = ['clinical:read', 'clinical:view', 'clinical:admin'] as const;
const WRITE = ['clinical:write'] as const;
const P = 'patients/:id/prescriptions';

@Controller()
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @Get('prescriptions')
  @RequireAnyPermission(...READ)
  recent(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListRecentPrescriptionsQuery, @Meta() meta: RequestMeta) {
    return this.prescriptions.listRecent(a, q.limit, q.offset, meta);
  }

  @Get(P)
  @RequireAnyPermission(...READ)
  list(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Query() q: ListPrescriptionsQuery, @Meta() meta: RequestMeta) {
    return this.prescriptions.list(a, id, Boolean(q.includeDeleted), meta);
  }

  @Post(P)
  @RequireAnyPermission(...WRITE)
  create(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: SavePrescriptionDto, @Meta() meta: RequestMeta) {
    return this.prescriptions.create(a, id, dto, meta);
  }

  @Get(`${P}/:rid`)
  @RequireAnyPermission(...READ)
  get(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Param('rid', uuid()) rid: string, @Meta() meta: RequestMeta) {
    return this.prescriptions.get(a, id, rid, meta);
  }

  @Put(`${P}/:rid`)
  @RequireAnyPermission(...WRITE)
  update(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('rid', uuid()) rid: string,
    @Body() dto: SavePrescriptionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.prescriptions.update(a, id, rid, dto, meta);
  }

  @Post(`${P}/:rid/delete`)
  @HttpCode(200)
  @RequireAnyPermission(...WRITE)
  remove(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('rid', uuid()) rid: string,
    @Body() dto: DeletePrescriptionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.prescriptions.remove(a, id, rid, dto, meta);
  }

  @Get(`${P}/:rid/pdf`)
  @RequireAnyPermission(...READ)
  async pdf(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('rid', uuid()) rid: string,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.prescriptions.pdf(a, id, rid, meta);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(out.body, { type: 'application/pdf', disposition: `attachment; filename="${out.filename}"`, length: out.body.length });
  }

  @Post(`${P}/:rid/email`)
  @HttpCode(200)
  @RequireAnyPermission(...READ)
  email(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('rid', uuid()) rid: string,
    @Body() dto: EmailPrescriptionDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.prescriptions.email(a, id, rid, dto, meta);
  }
}
