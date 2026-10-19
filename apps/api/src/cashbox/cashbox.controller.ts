import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { CashboxConfigService } from './cashbox-config.service.js';
import { renderCashReportPdf, type ReportInput } from './cashbox-report-pdf.js';
import {
  CloseSessionDto,
  CreateMovementDto,
  ListMovementsQuery,
  OpenSessionDto,
  ReportQuery,
  SaveAccountDto,
  SaveCategoryDto,
  VoidMovementDto,
} from './cashbox.dto.js';
import { CashboxService } from './cashbox.service.js';

const uuid = () => new ParseUUIDPipe();

@Controller('cashbox')
export class CashboxController {
  constructor(
    private readonly cashbox: CashboxService,
    private readonly config: CashboxConfigService,
  ) {}

  @Get('summary') @RequirePermissions('cashbox:read')
  summary(@CurrentPrincipal() a: AuthPrincipal) { return this.cashbox.summary(a); }

  @Get('config') @RequirePermissions('cashbox:read')
  getConfig(@CurrentPrincipal() a: AuthPrincipal) { return this.config.get(a); }

  @Post('accounts') @RequirePermissions('cashbox:manage')
  async createAccount(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: SaveAccountDto, @Meta() m: RequestMeta) { return { id: await this.config.createAccount(a, dto, m) }; }

  @Put('accounts/:id') @RequirePermissions('cashbox:manage')
  async updateAccount(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: SaveAccountDto, @Meta() m: RequestMeta) { await this.config.updateAccount(a, id, dto, m); return { id }; }

  @Post('categories') @RequirePermissions('cashbox:manage')
  async createCategory(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: SaveCategoryDto, @Meta() m: RequestMeta) { return { id: await this.config.createCategory(a, dto, m) }; }

  @Put('categories/:id') @RequirePermissions('cashbox:manage')
  async updateCategory(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: SaveCategoryDto, @Meta() m: RequestMeta) { await this.config.updateCategory(a, id, dto, m); return { id }; }

  @Post('open') @HttpCode(201) @RequirePermissions('cashbox:close')
  open(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: OpenSessionDto, @Meta() m: RequestMeta) { return this.cashbox.open(a, dto, m); }

  @Post('close') @HttpCode(200) @RequirePermissions('cashbox:close')
  close(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CloseSessionDto, @Meta() m: RequestMeta) { return this.cashbox.close(a, dto, m); }

  @Get('movements') @RequirePermissions('cashbox:read')
  list(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListMovementsQuery) { return this.cashbox.list(a, q); }

  @Post('movements') @HttpCode(201) @RequirePermissions('cashbox:write')
  create(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateMovementDto, @Meta() m: RequestMeta) { return this.cashbox.create(a, dto, m); }

  @Post('movements/:id/void') @HttpCode(200) @RequirePermissions('cashbox:void')
  voidMovement(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: VoidMovementDto, @Meta() m: RequestMeta) { return this.cashbox.void(a, id, dto, m); }

  @Get('report') @RequirePermissions('cashbox:read')
  async report(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ReportQuery, @Meta() m: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const data = await this.cashbox.reportData(a, q.from, q.to);
    // La salida de datos financieros se audita ANTES de entregar el documento.
    await this.cashbox.auditReport(a, q.from, q.to, m);
    const input: ReportInput = { ...data, generatedBy: `${a.user.firstName} ${a.user.lastName}`, generatedAt: new Date() };
    const pdf = await renderCashReportPdf(input);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="caja-chica-${q.from}-a-${q.to}.pdf"`, length: pdf.length });
  }
}
