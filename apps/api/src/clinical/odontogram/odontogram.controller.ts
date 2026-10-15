import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
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
  CloseOdontogramDto,
  DiscardOdontogramDto,
  ExportOdontogramQuery,
  MarkOdontogramErrorDto,
  SaveOdontogramDraftDto,
  StartOdontogramDraftDto,
} from '../dto/odontogram.dto.js';
import { OdontogramService } from './odontogram.service.js';

const uuid = () => new ParseUUIDPipe();
// El permiso de ruta solo exige tener ALGÚN permiso clínico; la decisión real y su auditoría las toma ClinicalAccessService.
const ANY_CLINICAL = [
  'clinical:read',
  'clinical:read_limited',
  'clinical:view',
  'clinical:read_all',
] as const;
const P = 'patients/:id/clinical/odontogram';

@Controller()
export class OdontogramController {
  constructor(private readonly odontogram: OdontogramService) {}

  /** Especificación visual y de estructura para el panel (no depende del paciente). */
  @Get('clinical/odontogram/spec')
  @RequireAnyPermission(...ANY_CLINICAL)
  spec() {
    return this.odontogram.spec();
  }

  @Get(P)
  @RequireAnyPermission(...ANY_CLINICAL)
  get(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.odontogram.get(a, id, meta);
  }

  @Get(`${P}/versions`)
  @RequireAnyPermission(...ANY_CLINICAL)
  versions(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.odontogram.versions(a, id, meta);
  }

  /** PDF (por omisión) o SVG de una versión guardada. */
  @Get(`${P}/export`)
  @RequireAnyPermission(...ANY_CLINICAL)
  async export(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Query() q: ExportOdontogramQuery,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.odontogram.export(a, id, q, meta);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(out.body, {
      type: out.type,
      disposition: `attachment; filename="${out.filename}"`,
      length: out.body.length,
    });
  }

  /** Abre el primer odontograma o un borrador nuevo (actualización, corrección o rectificación). */
  @Post(`${P}/draft`)
  @RequirePermissions('clinical:write')
  startDraft(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: StartOdontogramDraftDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.odontogram.startDraft(a, id, dto, meta);
  }

  @Put(`${P}/draft`)
  @RequirePermissions('clinical:write')
  saveDraft(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: SaveOdontogramDraftDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.odontogram.saveDraft(a, id, dto, meta);
  }

  @Post(`${P}/close`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  close(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: CloseOdontogramDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.odontogram.close(a, id, dto, meta);
  }

  @Post(`${P}/discard`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  discard(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: DiscardOdontogramDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.odontogram.discard(a, id, dto, meta);
  }

  @Post(`${P}/mark-error`)
  @HttpCode(200)
  @RequirePermissions('clinical:write')
  markError(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', uuid()) id: string,
    @Body() dto: MarkOdontogramErrorDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.odontogram.markError(a, id, dto, meta);
  }
}
