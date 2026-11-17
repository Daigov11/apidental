import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthPrincipal } from '../../auth/auth.types.js';
import { CurrentPrincipal } from '../../common/decorators/current-principal.decorator.js';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../../common/utils/request-meta.js';
import {
  CloseVisitOdontogramDto,
  CorrectVisitOdontogramDto,
  DiscardOdontogramDto,
  SaveOdontogramDraftDto,
  StartVisitOdontogramDto,
  VisitOdontogramPhaseDto,
} from '../dto/odontogram.dto.js';
import { VisitOdontogramService } from './visit-odontogram.service.js';

const uuid = () => new ParseUUIDPipe();
const phase = () => new ParseEnumPipe(VisitOdontogramPhaseDto);
// El permiso de ruta solo exige tener ALGÚN permiso clínico; la decisión real y su auditoría las toma ClinicalAccessService.
const ANY_CLINICAL = [
  'clinical:read',
  'clinical:read_limited',
  'clinical:view',
  'clinical:read_all',
] as const;
const P = 'patients/:id/clinical/visits/:visitId/odontogram';

/** Odontograma de la visita: diagnóstico (cómo llega el paciente) y post tratamiento (cómo sale). */
@Controller()
export class VisitOdontogramController {
  constructor(private readonly svc: VisitOdontogramService) {}

  @Get(P)
  @RequireAnyPermission(...ANY_CLINICAL)
  get(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.svc.get(a, id, visitId, meta);
  }

  /** PDF con ambas fases guardadas y las piezas que cambiaron. */
  @Get(`${P}/export`)
  @RequireAnyPermission(...ANY_CLINICAL)
  async export(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.svc.export(a, id, visitId, meta);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(out.body, {
      type: out.type,
      disposition: `attachment; filename="${out.filename}"`,
      length: out.body.length,
    });
  }

  @Post(`${P}/:phase/draft`)
  @RequirePermissions('clinical:write')
  start(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Param('phase', phase()) ph: VisitOdontogramPhaseDto,
    @Body() dto: StartVisitOdontogramDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.svc.start(a, id, visitId, ph, dto, meta);
  }

  @Put(`${P}/:phase/draft`)
  @RequirePermissions('clinical:write')
  save(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Param('phase', phase()) ph: VisitOdontogramPhaseDto,
    @Body() dto: SaveOdontogramDraftDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.svc.saveDraft(a, id, visitId, ph, dto, meta);
  }

  @Post(`${P}/:phase/close`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  close(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Param('phase', phase()) ph: VisitOdontogramPhaseDto,
    @Body() dto: CloseVisitOdontogramDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.svc.close(a, id, visitId, ph, dto, meta);
  }

  @Post(`${P}/:phase/discard`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  discard(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Param('phase', phase()) ph: VisitOdontogramPhaseDto,
    @Body() dto: DiscardOdontogramDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.svc.discard(a, id, visitId, ph, dto, meta);
  }

  @Post(`${P}/:phase/correct`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  correct(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Param('visitId', uuid()) visitId: string,
    @Param('phase', phase()) ph: VisitOdontogramPhaseDto,
    @Body() dto: CorrectVisitOdontogramDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.svc.correct(a, id, visitId, ph, dto, meta);
  }
}
