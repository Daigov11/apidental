import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import type { Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { AttachmentsService, type UploadedFileLike } from './attachments.service.js';
import { RemoveAttachmentDto, UploadAttachmentDto } from './dto/attachment.dto.js';

class ListAttachmentsQuery {
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeRemoved?: boolean;
}

/** Content-Disposition seguro: nombre ASCII de respaldo + filename* (RFC 5987) para tildes. */
function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Los archivos NO tienen URL pública: se suben y descargan solo por estos endpoints,
 * que exigen JWT, contexto de clínica y permiso, y dejan rastro de auditoría.
 */
@Controller('patients/:id/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @RequirePermissions('attachment:write')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: UploadAttachmentDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.attachments.upload(a, id, file, dto, meta);
  }

  @Get()
  @RequirePermissions('attachment:read')
  list(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: ListAttachmentsQuery,
    @Meta() meta: RequestMeta,
  ) {
    // Las bajas lógicas solo las ve quien puede gestionarlas.
    const includeRemoved = Boolean(q.includeRemoved) && a.permissions.has('attachment:write');
    return this.attachments.list(a, id, includeRemoved, meta);
  }

  @Get(':attachmentId/download')
  @RequirePermissions('attachment:read')
  async download(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.attachments.download(a, id, attachmentId, meta);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.data.length),
      'Content-Disposition': attachmentDisposition(file.fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(file.data);
  }

  @Post(':attachmentId/remove')
  @HttpCode(200)
  @RequirePermissions('attachment:write')
  remove(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Body() dto: RemoveAttachmentDto,
    @Meta() meta: RequestMeta,
  ) {
    return this.attachments.remove(a, id, attachmentId, dto, meta);
  }
}
