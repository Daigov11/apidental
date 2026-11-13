import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { refreshCookieOptions } from '../auth/cookies.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import { ApiworkingAuthService } from './apiworking-auth.service.js';
import { ApiworkingContingencyService } from './apiworking-contingency.service.js';
import { ApiworkingCashService } from './apiworking-cash.service.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import { ApiworkingSalesService } from './apiworking-sales.service.js';
import { ApiworkingLoginDto, BillingDraftQuery, CashCloseDraftDto, CashCloseDto, CashMovementDto, ContingencyDto, CustomerCreateDto, CustomerDraftDto, CashOpenDraftDto, CashOpenDto, CreateSaleDto, ExportSalesQuery, ListExternalClientsQuery, ListSalesQuery, ReconcileSaleDto, SaleDraftDto, SalesContextQuery, SalesSummaryQuery, VoidSaleDto } from './dto/apiworking.dto.js';

const uuid = () => new ParseUUIDPipe();

/** Cómo inicia sesión el panel (pública: la pantalla de acceso la necesita antes de autenticar). */
@Controller('auth')
export class ApiworkingAuthController {
  constructor(private readonly auth: ApiworkingAuthService, private readonly config: AppConfig) {}

  @Public()
  @Get('config')
  authConfig() {
    return { mode: this.config.authMode };
  }

  /** Igual que el login local: el access token va en el cuerpo y el refresh token SOLO en cookie HttpOnly. */
  @Public()
  @Post('apiworking-login')
  @HttpCode(200)
  async login(@Body() dto: ApiworkingLoginDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { body, refreshToken } = await this.auth.login(dto.usuario, dto.password, meta);
    res.cookie(this.config.session.cookie.name, refreshToken, refreshCookieOptions(this.config));
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    return body;
  }
}

@Controller('apiworking')
export class ApiworkingController {
  constructor(
    private readonly clients: ApiworkingClientsService,
    private readonly sales: ApiworkingSalesService,
    private readonly cash: ApiworkingCashService,
    private readonly contingency: ApiworkingContingencyService,
    private readonly config: AppConfig,
  ) {}

  /** Estado para el panel: qué está activo y si la sesión de Apiworking sigue disponible. */
  @Get('status')
  @RequirePermissions('apiworking:read')
  status(@CurrentPrincipal() a: AuthPrincipal) {
    const c = this.config.apiworking;
    let session = false;
    try {
      session = Boolean(this.clients.requireSession(a));
    } catch {
      session = false;
    }
    return { configured: c.configured, read: c.read, write: c.write, tenant: c.expectedDatabase, session };
  }

  @Get('clients')
  @RequirePermissions('apiworking:read')
  listClients(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListExternalClientsQuery) {
    return this.clients.list(a, q);
  }

  /** Datos para cobrar desde una cita atendida o un paciente (no consulta a Apiworking: sirve también en contingencia). */
  @Get('billing-draft')
  @RequirePermissions('apiworking:sell')
  billingDraft(@CurrentPrincipal() a: AuthPrincipal, @Query() q: BillingDraftQuery, @Meta() m: RequestMeta) {
    return this.contingency.billingDraft(a, q, m);
  }

  /** Cobro en contingencia: Apiworking no responde; el dinero entra en la caja local y el documento queda por emitir. */
  @Post('contingency')
  @RequirePermissions('apiworking:sell', 'cashbox:write')
  recordContingency(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: ContingencyDto, @Meta() m: RequestMeta) {
    return this.contingency.record(a, dto, m);
  }

  @Post('clients/preview')
  @HttpCode(200)
  @RequirePermissions('apiworking:sell')
  customerPreview(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CustomerDraftDto) {
    return this.clients.previewCreate(a, dto);
  }

  /** Nombres de una persona por su documento (para el alta de pacientes). */
  @Post('clients/lookup')
  @HttpCode(200)
  @RequirePermissions('apiworking:sell')
  customerLookup(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CustomerDraftDto, @Meta() m: RequestMeta) {
    return this.clients.lookup(a, dto, m);
  }

  @Post('clients')
  @HttpCode(200)
  @RequirePermissions('apiworking:sell')
  customerCreate(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CustomerCreateDto, @Meta() m: RequestMeta) {
    return this.clients.create(a, dto, m);
  }

  @Get('sales/context')
  @RequirePermissions('apiworking:read')
  context(@CurrentPrincipal() a: AuthPrincipal, @Query() q: SalesContextQuery) {
    return this.sales.context(a, q.idCaja, q.idTipoDocumento);
  }

  /** Solo administradores: todo lo que Apiworking informa, para decidir qué autorizar (no escribe nada). */
  @Get('discovery')
  @RequirePermissions('apiworking:configure')
  discovery(@CurrentPrincipal() a: AuthPrincipal, @Query() q: SalesContextQuery) {
    return this.sales.discovery(a, q.idCaja, q.idTipoDocumento);
  }

  @Get('cash')
  @RequirePermissions('apiworking:read')
  cashStatus(@CurrentPrincipal() a: AuthPrincipal) {
    return this.cash.status(a);
  }

  @Post('cash/preview')
  @HttpCode(200)
  @RequirePermissions('apiworking:cash')
  cashPreview(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CashOpenDraftDto) {
    return this.cash.preview(a, dto);
  }

  @Post('cash/open')
  @HttpCode(200)
  @RequirePermissions('apiworking:cash')
  cashOpen(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CashOpenDto, @Meta() m: RequestMeta) {
    return this.cash.open(a, dto, m);
  }

  /** Ingreso o egreso manual en la caja abierta (ingreso-egreso de Apiworking). */
  @Post('cash/movements')
  @HttpCode(200)
  @RequirePermissions('apiworking:cash')
  cashMovement(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CashMovementDto, @Meta() m: RequestMeta) {
    return this.cash.movement(a, dto, m);
  }

  @Post('cash/close-preview')
  @HttpCode(200)
  @RequirePermissions('apiworking:cash')
  cashClosePreview(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CashCloseDraftDto) {
    return this.cash.closePreview(a, dto);
  }

  @Post('cash/close')
  @HttpCode(200)
  @RequirePermissions('apiworking:cash')
  cashClose(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CashCloseDto, @Meta() m: RequestMeta) {
    return this.cash.close(a, dto, m);
  }

  @Post('sales/preview')
  @HttpCode(200)
  @RequirePermissions('apiworking:sell')
  preview(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: SaleDraftDto) {
    return this.sales.preview(a, dto);
  }

  @Post('sales')
  @RequirePermissions('apiworking:sell')
  create(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateSaleDto, @Meta() m: RequestMeta) {
    return this.sales.create(a, dto, m);
  }

  @Get('sales')
  @RequirePermissions('apiworking:read')
  list(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListSalesQuery, @Meta() m: RequestMeta) {
    return this.sales.list(a, q, m);
  }

  /** Historial de ventas en Excel (xlsx) o PDF, con los filtros de la lista. */
  @Get('sales/export')
  @RequirePermissions('apiworking:read')
  async exportSales(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ExportSalesQuery, @Meta() m: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const out = await this.sales.exportHistory(a, q, m);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(out.body, { type: out.type, disposition: `attachment; filename="${out.filename}"`, length: out.body.length });
  }

  @Get('sales/summary')
  @RequirePermissions('apiworking:read')
  salesSummary(@CurrentPrincipal() a: AuthPrincipal, @Query() q: SalesSummaryQuery) {
    return this.sales.summary(a, q.date);
  }

  @Get('sales/:id')
  @RequirePermissions('apiworking:read')
  get(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string) {
    return this.sales.get(a, id);
  }

  @Post('sales/:id/verify')
  @HttpCode(200)
  @RequirePermissions('apiworking:sell')
  verify(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() m: RequestMeta) {
    return this.sales.verify(a, id, m);
  }

  @Post('sales/:id/reconcile')
  @HttpCode(200)
  @RequirePermissions('apiworking:sell')
  reconcile(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: ReconcileSaleDto, @Meta() m: RequestMeta) {
    return this.sales.reconcile(a, id, dto, m);
  }

  @Post('sales/:id/pay')
  @HttpCode(200)
  @RequirePermissions('apiworking:sell')
  pay(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Meta() m: RequestMeta) {
    return this.sales.pay(a, id, m);
  }

  @Post('sales/:id/void')
  @HttpCode(200)
  @RequirePermissions('apiworking:void')
  voidSale(@CurrentPrincipal() a: AuthPrincipal, @Param('id', uuid()) id: string, @Body() dto: VoidSaleDto, @Meta() m: RequestMeta) {
    return this.sales.voidSale(a, id, dto.reason, m);
  }
}
