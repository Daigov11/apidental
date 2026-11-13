import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { clinicScope, isUniqueViolation } from '../patients/patient-access.js';
import { markServicesBilled, releaseServices, requirePendingServices, resolveBillingLink } from './billing-link.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { enforceRealOperationsCap } from './real-operations.js';
import { buildXlsx } from '../common/utils/xlsx.js';
import { renderSalesPdf } from './sales-pdf.js';
import { ApiworkingClient, ApiworkingError, asResult, asRows, cajaId, cajaName, allowed, clip, isNoData, moneyToCents, optText, reqId, reqIdAny } from './apiworking.client.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import type { ExternalSession } from './apiworking-session.store.js';
import type { ReconcileSaleDto, SaleDraftDto } from './dto/apiworking.dto.js';

type SaleRow = Prisma.ApiworkingSaleGetPayload<object>;

const DOC_LABELS = { PENDING_ISSUE: 'Cobrado en contingencia: por emitir', PENDING: 'Enviando', SENT: 'Registrado en Apiworking', REJECTED: 'Rechazado', PENDING_RECONCILIATION: 'Enviado: número por confirmar' } as const;
const PAYMENT_LABELS = { NO_EVIDENCE: 'Pago pendiente', CONFIRMED_REMOTE: 'Pagado', CONFIRMED_RECONCILED: 'Pagado' } as const;
/** Cada cuánto se vuelve a buscar en Apiworking una venta con número por confirmar (al listar). */
const LOCATE_EVERY_MS = 2 * 60 * 1000;
const VOID_LABELS = { IN_PROGRESS: 'Anulación en curso', VOIDED: 'Anulado', TO_RECONCILE: 'Anulación por conciliar' } as const;
/** Unidad de medida por defecto: «1» = NIU (según el responsable del tenant). */
const DEFAULT_UNIT = '1';
/** Almacén = sucursal del login de Apiworking (`id_sucursal`); el .env solo lo sobrescribe si hace falta. */
const warehouseOf = (cfg: { warehouseId: string | null }, session: ExternalSession) => cfg.warehouseId ?? session.branchId;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Nombre legible de una fila: el contrato no lo fija, se usa el primer campo conocido que exista. */
const label = (r: Record<string, unknown>, keys: string[], fallback: string) => keys.map((k) => optText(r, k)).find(Boolean) ?? fallback;
const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;
/** Partes del pago de una venta: las guardadas (varios medios) o un solo medio por el total. */
export const paymentsOf = (s: { payments: unknown; paymentMethodId: string; totalCents: number }): { idMetodoPago: string; amountCents: number }[] =>
  Array.isArray(s.payments) && s.payments.length > 0 ? (s.payments as { idMetodoPago: string; amountCents: number }[]) : [{ idMetodoPago: s.paymentMethodId, amountCents: s.totalCents }];
/**
 * Reparte el descuento entre las líneas en proporción a su importe, en céntimos exactos (la suma da el descuento): el resto del
 * redondeo va a las líneas de mayor importe.
 */
export function splitDiscount(lineTotals: number[], discount: number): number[] {
  const gross = lineTotals.reduce((a, b) => a + b, 0);
  if (discount <= 0 || gross <= 0) return lineTotals.map(() => 0);
  const parts = lineTotals.map((t) => Math.floor((discount * t) / gross));
  let rest = discount - parts.reduce((a, b) => a + b, 0);
  const order = lineTotals.map((t, i) => [t, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length) {
    const i = order[k]!;
    if (parts[i]! < lineTotals[i]!) { parts[i]! += 1; rest -= 1; }
  }
  return parts;
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const limaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
/** 2026-08-20 -> 20-08-2026 (formato de fechas de Apiworking, sin zona horaria). */
const dmy = (iso: string) => iso.split('-').reverse().join('-');

export function presentSale(s: SaleRow) {
  return {
    id: s.id,
    description: s.description,
    customerId: s.externalCustomerId,
    customer: { name: s.customerName, docType: s.customerDocType, docNumber: s.customerDocNumber },
    totalCents: s.totalCents,
    totalText: money(s.totalCents),
    discountCents: s.discountCents,
    payments: paymentsOf(s),
    lines: s.lines,
    docDate: s.docDate.toISOString().slice(0, 10),
    contingency: s.contingency,
    appointmentId: s.appointmentId,
    patientId: s.patientId,
    serie: s.serie,
    docStatus: s.docStatus,
    docStatusLabel: DOC_LABELS[s.docStatus],
    paymentStatus: s.paymentStatus,
    paymentStatusLabel: PAYMENT_LABELS[s.paymentStatus],
    voidStatus: s.voidStatus,
    voidStatusLabel: s.voidStatus ? VOID_LABELS[s.voidStatus] : null,
    externalDocId: s.externalDocId,
    externalNumber: s.externalNumber,
    failureReason: s.failureReason,
    attemptedAt: s.attemptedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    actions: {
      issue: s.docStatus === 'PENDING_ISSUE',
      verify: s.docStatus === 'SENT' || s.docStatus === 'PENDING_RECONCILIATION' || s.voidStatus === 'IN_PROGRESS',
      reconcile: s.docStatus === 'PENDING_RECONCILIATION' || s.docStatus === 'PENDING',
      pay: s.docStatus === 'SENT' && !!s.externalDocId && s.paymentStatus === 'NO_EVIDENCE' && s.voidStatus === null,
      void: s.docStatus === 'SENT' && (s.voidStatus === null || s.voidStatus === 'TO_RECONCILE'),
    },
  };
}

/**
 * Ventas por `registro-documento` de Apiworking, de un solo paso (flujo «venta cobrada» de la guía de integración):
 * caja del usuario que inició sesión -> registro-documento (UNA vez, sin reintentos) -> registrar-pago automático. Un resultado
 * dudoso no se reenvía: el sistema busca solo el comprobante en GET /api/Facturacion y, si lo encuentra, lo da por registrado
 * y aplica el pago. Documento, cobro y anulación siguen siendo estados distintos. El tope por 24 h es opcional.
 */
@Injectable()
export class ApiworkingSalesService {
  private readonly diag = new Logger('ApiworkingSales');
  /** Última búsqueda automática de cada venta con número por confirmar (evita consultar Apiworking en cada listado). */
  private readonly located = new Map<string, number>();
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly config: AppConfig,
    private readonly client: ApiworkingClient,
    private readonly clients: ApiworkingClientsService,
    private readonly audit: AuditService,
  ) {}

  // --- Contexto: lecturas previas (caja, apertura, tipos, series, formas de pago), siempre dentro de las listas autorizadas ---

  async context(principal: AuthPrincipal, idCaja?: string, idTipoDocumento?: string) {
    const session = this.clients.requireSession(principal);
    const cfg = this.config.apiworking;
    const cajas = asRows(await this.client.call('caja', { token: session.token }), 'las cajas')
      .map((r) => ({ id: cajaId(r), name: cajaName(r), branch: optText(r, 'sucursal') }))
      .filter((c) => allowed(cfg.authorizedCashRegisters, c.id));
    const out: Record<string, unknown> = { cajas, authorizedConfigured: cfg.authorizedCashRegisters.length > 0 };
    if (!idCaja) return out;
    if (!cajas.some((c) => c.id === idCaja)) throw new BadRequestException('La caja no está autorizada para esta instalación');

    const opened = await this.openMovement(session, idCaja);
    out['opened'] = opened !== null;
    const tipos = (await this.documentTypes(session, idCaja)).filter((t) => allowed(cfg.authorizedDocumentTypes, t.id));
    out['documentTypes'] = tipos;
    if (idTipoDocumento) {
      if (!tipos.some((t) => t.id === idTipoDocumento)) throw new BadRequestException('El tipo de documento no está autorizado');
      out['series'] = (await this.seriesOf(session, idCaja, idTipoDocumento)).filter((s) => allowed(cfg.authorizedSeries, s.id));
      out['paymentMethods'] = opened ? await this.paymentMethods(session, opened) : [];
    }
    return out;
  }

  /**
   * Descubrimiento para el administrador: TODAS las cajas, tipos de documento y series que Apiworking informa, marcando cuáles ya
   * están autorizadas en esta instalación. Solo lectura: sirve para decidir qué ids poner en las listas autorizadas del .env.
   */
  async discovery(principal: AuthPrincipal, idCaja?: string, idTipoDocumento?: string) {
    const session = this.clients.requireSession(principal);
    const cfg = this.config.apiworking;
    const cajas = asRows(await this.client.call('caja', { token: session.token }), 'las cajas').map((r) => {
      const id = cajaId(r);
      return { id, name: cajaName(r), branch: optText(r, 'sucursal'), authorized: allowed(cfg.authorizedCashRegisters, id) };
    });
    const out: Record<string, unknown> = { cajas, write: cfg.write, warehouseId: warehouseOf(cfg, session), unitId: cfg.unitId ?? DEFAULT_UNIT };
    if (!idCaja) return out;
    if (!cajas.some((c) => c.id === idCaja)) throw new BadRequestException('La caja no existe en Apiworking');
    const opened = await this.openMovement(session, idCaja);
    out['opened'] = opened !== null;
    const tipos = (await this.documentTypes(session, idCaja)).map((t) => ({ ...t, authorized: allowed(cfg.authorizedDocumentTypes, t.id) }));
    out['documentTypes'] = tipos;
    if (idTipoDocumento) {
      if (!tipos.some((t) => t.id === idTipoDocumento)) throw new BadRequestException('El tipo de documento no corresponde a la caja');
      out['series'] = (await this.seriesOf(session, idCaja, idTipoDocumento)).map((s) => ({ ...s, authorized: allowed(cfg.authorizedSeries, s.id) }));
      out['paymentMethods'] = opened ? await this.paymentMethods(session, opened) : [];
    }
    return out;
  }

  private async openMovement(session: ExternalSession, idCaja: string): Promise<string | null> {
    const data = await this.client.call('cajaApertura', { token: session.token, query: { idCaja } }).catch((e: unknown) => {
      if (isNoData(e)) return [];
      throw e;
    });
    const row = asRows(data, 'la apertura de caja')[0];
    const id = row ? optText(row, 'id_movimiento_caja') : '';
    return id || null;
  }

  private async documentTypes(session: ExternalSession, idCaja: string) {
    const data = await this.client.call('tipoDocumentos', { token: session.token, query: { idcaja: idCaja } });
    return asRows(data, 'los tipos de documento').map((r) => ({ id: reqId(r, 'id_tipo_documento', 'un tipo de documento'), name: label(r, ['tipo_documento', 'tipoDocumento', 'nombre', 'descripcion', 'documento'], 'Documento') }));
  }

  private async seriesOf(session: ExternalSession, idCaja: string, idTipoDocumento: string) {
    const data = await this.client.call('series', { token: session.token, query: { idTipoDocumento, idCaja } });
    return asRows(data, 'las series').map((r) => ({ id: reqId(r, 'id_serie', 'una serie'), serie: reqId(r, 'serie', 'una serie') }));
  }

  private async paymentMethods(session: ExternalSession, movementId: string) {
    const data = await this.client.call('formasPago', { token: session.token, query: { idMovimientoCaja: movementId } });
    return asRows(data, 'las formas de pago').map((r) => ({ id: reqId(r, 'id_metodo_pago', 'una forma de pago'), name: label(r, ['metodoPago'], 'Pago') }));
  }

  /** Caja con la que se vende: la del usuario que inició sesión (GET /api/Caja), dentro de las autorizadas si las hay. */
  private async sessionCaja(session: ExternalSession): Promise<string> {
    const cfg = this.config.apiworking;
    const id = asRows(await this.client.call('caja', { token: session.token }), 'las cajas').map(cajaId).find((c) => allowed(cfg.authorizedCashRegisters, c));
    if (!id) throw new ConflictException({ message: 'Su usuario de Apiworking no tiene una caja asignada', code: 'NO_CASH_REGISTER' });
    return id;
  }

  // --- Vista previa: el JSON exacto que se enviaría, con su SHA-256 ---

  async preview(principal: AuthPrincipal, draft: SaleDraftDto) {
    const built = await this.build(principal, draft);
    return {
      request: built.body,
      hash: built.hash,
      totalCents: built.totalCents,
      totalText: money(built.totalCents),
      customer: built.customer,
      serie: built.serie,
      suggestedDocument: suggestDocument(built.customer.docType),
      mode: this.config.apiworking.write ? 'LIVE' : 'READ_ONLY',
      writeEnabled: this.config.apiworking.write,
      warnings: [] as string[],
    };
  }

  private async build(principal: AuthPrincipal, draft: SaleDraftDto) {
    const cfg = this.config.apiworking;
    const session = this.clients.requireSession(principal);
    const idCaja = draft.idCaja ?? (await this.sessionCaja(session));
    if (!allowed(cfg.authorizedCashRegisters, idCaja) || !allowed(cfg.authorizedDocumentTypes, draft.idTipoDocumento) || !allowed(cfg.authorizedSeries, draft.idSerie)) {
      throw new BadRequestException('La caja, el tipo de documento o la serie no están autorizados para esta instalación');
    }
    const warehouse = warehouseOf(cfg, session);
    const unit = cfg.unitId ?? DEFAULT_UNIT;
    if (!warehouse || !Number.isSafeInteger(Number(warehouse))) throw new ServiceUnavailableException('Apiworking no informó la sucursal (id_sucursal) del usuario: no se puede determinar el almacén');
    for (const id of [draft.customerId, draft.idSerie]) {
      if (!Number.isSafeInteger(Number(id))) throw new BadRequestException('Identificador de Apiworking fuera de rango');
    }
    const link = await resolveBillingLink(this.db, principal, { patientId: draft.patientId, appointmentId: draft.appointmentId, excludeSaleId: draft.pendingSaleId });
    const serviceIds = await requirePendingServices(this.db, clinicScope(principal).clinicId, link.patientId, draft.visitServiceIds);
    const customer = await this.clients.find(principal, draft.customerId);
    if (!customer) throw new BadRequestException('El cliente no existe (o está inactivo) en Apiworking');

    // Se revalidan caja, tipo, serie y forma de pago en cada vista previa y en cada envío: pueden cambiar.
    const movement = await this.openMovement(session, idCaja);
    if (!movement) throw new ConflictException({ message: 'La caja no tiene una apertura vigente en Apiworking', code: 'CASH_REGISTER_CLOSED' });
    if (!(await this.documentTypes(session, idCaja)).some((t) => t.id === draft.idTipoDocumento)) throw new BadRequestException('El tipo de documento no corresponde a la caja');
    const serie = (await this.seriesOf(session, idCaja, draft.idTipoDocumento)).find((s) => s.id === draft.idSerie);
    if (!serie) throw new BadRequestException('La serie no corresponde a la caja y al tipo de documento');
    const methods = await this.paymentMethods(session, movement);
    if (!methods.some((m) => m.id === draft.idMetodoPago)) throw new BadRequestException('La forma de pago no está disponible en la apertura de caja');

    const lineTotals = draft.lines.map((l) => l.quantity * l.unitPriceCents);
    const grossCents = lineTotals.reduce((sum, t) => sum + t, 0);
    const discountCents = draft.discountCents ?? 0;
    if (discountCents >= grossCents) throw new BadRequestException('El descuento no puede ser igual o mayor que el total');
    const totalCents = grossCents - discountCents;
    if (totalCents < 1 || grossCents > 1_000_000_000) throw new BadRequestException('El total de la venta está fuera de rango');
    const lineDiscounts = splitDiscount(lineTotals, discountCents);
    // Pago: un solo medio por el total, o varios medios que suman exactamente el total con descuento.
    const payments = draft.payments?.length ? draft.payments.map((p) => ({ idMetodoPago: p.idMetodoPago, amountCents: p.amountCents })) : [{ idMetodoPago: draft.idMetodoPago, amountCents: totalCents }];
    if (payments.reduce((t, p) => t + p.amountCents, 0) !== totalCents) throw new BadRequestException('La suma de los pagos debe ser igual al total a cobrar');
    if (new Set(payments.map((p) => p.idMetodoPago)).size !== payments.length) throw new BadRequestException('Cada forma de pago se indica una sola vez');
    for (const p of payments) if (!methods.some((m) => m.id === p.idMetodoPago)) throw new BadRequestException('Una forma de pago no está disponible en la apertura de caja');
    if (draft.payments?.length && payments[0]!.idMetodoPago !== draft.idMetodoPago) throw new BadRequestException('La primera forma de pago debe ser la forma de pago principal');
    const docDate = draft.docDate ?? limaToday();
    if (Number.isNaN(Date.parse(`${docDate}T00:00:00Z`))) throw new BadRequestException('Fecha inválida');

    const body = {
      idCaja,
      idCliente: Number(draft.customerId),
      idSerie: Number(draft.idSerie),
      observacion: draft.description,
      detalle: draft.lines.map((l, i) => ({
        idProducto: 0,
        idAlmacen: Number(warehouse),
        grupo: '0',
        itemPedido: String(i + 1),
        cantidad: l.quantity,
        precioVenta: Number((l.unitPriceCents / 100).toFixed(2)),
        combos: '',
        tipoIGV: '',
        tributo: '',
        nombreProducto: l.name,
        detalleItem: '',
        idUnidadMedida: unit,
        isc: 0,
        // Descuento de la línea: porcentaje y monto (céntimos exactos repartidos con splitDiscount).
        descuento: lineDiscounts[i] ? Number(((lineDiscounts[i]! * 100) / lineTotals[i]!).toFixed(2)) : 0,
        descuentoImporte: lineDiscounts[i] ? Number((lineDiscounts[i]! / 100).toFixed(2)) : 0,
        idDetalle: '',
        cadenaLotes: '',
      })),
      cadenaPago: payments.map((p) => `${p.idMetodoPago}^${(p.amountCents / 100).toFixed(2)}^0~`).join(''),
      fechaDoc: docDate,
      aplicaIGV: '1',
      // El total lo calcula Apiworking; el total local se muestra y se guarda aparte.
      totalVenta: 0,
    };
    // El enlace con paciente y cita también queda aprobado: cambiarlo invalida la vista previa.
    const linkSuffix = link.appointmentId || link.patientId ? `|p:${link.patientId ?? ''}|a:${link.appointmentId ?? ''}` : '';
    return { body, idCaja, hash: sha256(JSON.stringify(body) + linkSuffix), totalCents, discountCents, payments, customer, serie: serie.serie, docDate, patientId: link.patientId, appointmentId: link.appointmentId, serviceIds };
  }

  // --- Venta: un solo envío del documento, sin reintentos, y el pago aplicado a continuación ---

  async create(principal: AuthPrincipal, dto: SaleDraftDto & { approvedHash?: string; idempotencyKey: string }, meta: RequestMeta) {
    const { clinicId } = clinicScope(principal);
    const cfg = this.config.apiworking;
    if (!cfg.write) throw new ServiceUnavailableException({ message: 'Las escrituras reales de Apiworking están desactivadas en esta instalación', code: 'WRITE_DISABLED' });

    const existing = await this.db.apiworkingSale.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      if (existing.clinicId !== clinicId || (dto.approvedHash && existing.requestHash !== dto.approvedHash)) throw new ConflictException({ message: 'La clave de idempotencia ya se usó con otra venta', code: 'IDEMPOTENCY_MISMATCH' });
      return presentSale(existing);
    }

    // Emisión de una venta cobrada en contingencia: se completa ESA fila; no puede cambiar el cliente ni el monto cobrado.
    let pending: SaleRow | null = null;
    if (dto.pendingSaleId) {
      pending = await this.db.apiworkingSale.findFirst({ where: { id: dto.pendingSaleId, clinicId } });
      if (!pending) throw new NotFoundException('Venta pendiente no encontrada');
      if (pending.docStatus !== 'PENDING_ISSUE') throw new ConflictException({ message: 'Esa venta ya no está pendiente de emitir', code: 'NOT_PENDING_ISSUE' });
    }

    const built = await this.build(principal, dto);
    if (dto.approvedHash && built.hash !== dto.approvedHash) throw new ConflictException({ message: 'La venta cambió después de la vista previa: revise y apruebe de nuevo', code: 'PREVIEW_CHANGED' });
    if (pending && (built.customer.id !== pending.externalCustomerId || built.totalCents !== pending.totalCents)) {
      throw new ConflictException({ message: 'El cliente y el monto de una venta cobrada en contingencia no se pueden cambiar al emitirla', code: 'PENDING_CHANGED' });
    }

    const tenant = cfg.expectedDatabase!;
    const recent = await this.db.apiworkingSale.count({ where: { tenant, attemptedAt: { gte: new Date(Date.now() - WINDOW_MS) } } });
    if (cfg.maxRealOperations > 0 && recent >= cfg.maxRealOperations) {
      throw new ConflictException({ message: `Se alcanzó el tope de ${cfg.maxRealOperations} envíos reales en 24 horas (APIWORKING_MAX_REAL_OPERATIONS)`, code: 'REAL_OPERATIONS_LIMIT' });
    }

    let sale: SaleRow;
    try {
      // La fila nace ANTES de llamar a Apiworking, con la marca de intento: si el proceso muere a mitad, queda constancia.
      sale = pending
        ? await this.db.apiworkingSale.update({
            where: { id: pending.id },
            data: {
              idempotencyKey: dto.idempotencyKey,
              requestHash: built.hash,
              idCaja: built.idCaja,
              idSerie: dto.idSerie,
              serie: built.serie,
              documentTypeId: dto.idTipoDocumento,
              paymentMethodId: dto.idMetodoPago,
              docDate: new Date(`${built.docDate}T00:00:00Z`),
              docStatus: 'PENDING',
              failureReason: null,
              attemptedAt: new Date(),
            },
          })
        : await this.db.apiworkingSale.create({
            data: {
              clinicId,
              tenant,
              idempotencyKey: dto.idempotencyKey,
              requestHash: built.hash,
              patientId: built.patientId,
              appointmentId: built.appointmentId,
              externalCustomerId: built.customer.id,
              customerName: built.customer.name.slice(0, 200),
              customerDocType: built.customer.docType.slice(0, 20),
              customerDocNumber: built.customer.docNumber.slice(0, 20),
              idCaja: built.idCaja,
              idSerie: dto.idSerie,
              serie: built.serie,
              documentTypeId: dto.idTipoDocumento,
              paymentMethodId: dto.idMetodoPago,
              description: dto.description,
              lines: dto.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
              totalCents: built.totalCents,
              discountCents: built.discountCents,
              ...(built.payments.length > 1 ? { payments: built.payments } : {}),
              docDate: new Date(`${built.docDate}T00:00:00Z`),
              attemptedAt: new Date(),
              createdById: principal.user.id,
            },
          });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.db.apiworkingSale.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
      if (!raced) throw error;
      return presentSale(raced);
    }

    const session = this.clients.requireSession(principal);
    let updated: SaleRow;
    try {
      const data = await this.client.call('registroDocumento', { token: session.token, body: built.body });
      const r = asResult(data, 'el registro del documento');
      const result = r['result'];
      const hasError = r['error'] !== null && r['error'] !== undefined && r['error'] !== '';
      if ((result !== 1 && result !== '1') || hasError) {
        // Respuesta 200 pero sin la forma esperada: el documento pudo registrarse. No se da por bueno ni por malo.
        updated = await this.settle(sale.id, { docStatus: 'PENDING_RECONCILIATION', failureReason: 'Respuesta de Apiworking incompleta: verifique si el documento existe' });
        await this.log(AuditAction.ApiworkingSaleUnknown, updated, principal, meta, { reason: 'unexpected_shape' });
      } else {
        const numero = optText(r, 'numero');
        updated = await this.settle(sale.id, { docStatus: 'SENT', failureReason: null, externalDocId: reqIdAny(r, ['idComprobante', 'idDocumentoPago', 'idDocumento', 'id_comprobante', 'id'], 'el registro del documento'), externalNumber: optText(r, 'nroComprobante') || optText(r, 'numeroComprobante') || (numero ? `${built.serie}-${numero}` : null) });
        await this.log(updated.contingency ? AuditAction.ApiworkingContingencyIssued : AuditAction.ApiworkingSaleSent, updated, principal, meta, {});
      }
    } catch (error) {
      updated = await this.settleFailure(sale.id, error, principal, meta);
    }
    // Lo cobrado de la cuenta pendiente queda marcado (también con resultado dudoso: el documento pudo registrarse).
    if (updated.docStatus === 'SENT' || updated.docStatus === 'PENDING_RECONCILIATION') await markServicesBilled(this.db, clinicId, updated.id, built.serviceIds);
    // Resultado dudoso: se busca solo el comprobante en Apiworking (lectura) en vez de pedir una conciliación manual.
    if (updated.docStatus === 'PENDING_RECONCILIATION') updated = await this.locate(updated, principal, meta);
    // Venta cobrada: el pago se aplica en el mismo paso (registro-documento no lo aplica). La de contingencia ya se cobró en la caja local.
    if (updated.docStatus === 'SENT' && !updated.contingency && updated.paymentStatus === 'NO_EVIDENCE') updated = await this.autoPay(updated, principal, meta);
    return presentSale(updated);
  }

  /** Aplica el pago sin interrumpir la venta: si falla, el documento queda registrado y el pago pendiente. */
  private async autoPay(sale: SaleRow, principal: AuthPrincipal, meta: RequestMeta): Promise<SaleRow> {
    try {
      return await this.applyPayment(sale, principal, meta, true);
    } catch (error) {
      const raw = error instanceof ConflictException || error instanceof ServiceUnavailableException ? (error.getResponse() as { message?: unknown }).message : error instanceof Error ? error.message : '';
      const msg = typeof raw === 'string' ? raw : '';
      this.diag.warn(`pago automático no aplicado (${sale.id}): ${clip(msg)}`);
      return this.settle(sale.id, { failureReason: clip(`Pago no aplicado en Apiworking: ${msg || 'sin detalle'}`) });
    }
  }

  /**
   * Busca en GET /api/Facturacion el comprobante de una venta con resultado dudoso (mismo total y serie, del día, sin otra venta
   * local que lo tenga). Con UNA coincidencia la da por registrada; si además trae su id y no tiene pagos, aplica el pago.
   * Nunca reenvía el documento. Un fallo de la búsqueda deja la venta como estaba.
   */
  private async locate(sale: SaleRow, principal: AuthPrincipal, meta: RequestMeta): Promise<SaleRow> {
    this.located.set(sale.id, Date.now());
    try {
      const session = this.clients.requireSession(principal);
      const day = sale.docDate.toISOString().slice(0, 10);
      const next = new Date(sale.docDate.getTime() + 86_400_000).toISOString().slice(0, 10);
      const data = await this.client
        .call('facturacion', { token: session.token, query: { idSucursal: session.branchId ?? undefined, fechaInicio: dmy(day), fechaFin: dmy(next), displayStart: 0, displayLength: 100, allFechas: 0 } })
        .catch((e: unknown) => {
          if (isNoData(e)) return [];
          throw e;
        });
      const rows = asRows(data, 'los documentos');
      const taken = new Set((await this.db.apiworkingSale.findMany({ where: { tenant: sale.tenant, externalNumber: { not: null }, NOT: { id: sale.id } }, select: { externalNumber: true } })).map((s) => s.externalNumber));
      const matches = rows
        .map((r) => ({ number: optText(r, 'nroComprobante'), id: optText(r, 'id_documento_pago') || optText(r, 'idDocumentoPago') || optText(r, 'idComprobante'), status: optText(r, 'estado'), totalCents: moneyToCents(r['totalVenta']), doc: optText(r, 'numerodocumento_cliente') }))
        .filter((f) => f.number && !taken.has(f.number) && f.totalCents === sale.totalCents && (!sale.serie || f.number.startsWith(`${sale.serie}-`)) && (!f.doc || f.doc === sale.customerDocNumber) && !/^a/i.test(f.status));
      if (matches.length !== 1) return sale;
      const m = matches[0]!;
      let updated = await this.settle(sale.id, { docStatus: 'SENT', externalNumber: m.number, externalDocId: m.id && Number.isSafeInteger(Number(m.id)) ? m.id : null, failureReason: null });
      await this.audit.recordSafely({ action: AuditAction.ApiworkingSaleReconciled, entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId: sale.clinicId, meta, summary: { outcome: 'REGISTERED', auto: true, externalNumber: m.number } });
      if (updated.externalDocId && !updated.contingency && updated.paymentStatus === 'NO_EVIDENCE') {
        const paid = await this.paidCents(session, updated.externalDocId);
        updated = paid >= updated.totalCents ? await this.settle(sale.id, { paymentStatus: 'CONFIRMED_REMOTE' }) : await this.autoPay(updated, principal, meta);
      }
      return updated;
    } catch (error) {
      this.diag.warn(`búsqueda automática del comprobante sin resultado (${sale.id}): ${clip(error instanceof Error ? error.message : '')}`);
      return sale;
    }
  }

  /** Suma de pagos aplicados a un documento (controlPagos). «No se encontraron pagos» = 0. */
  private async paidCents(session: ExternalSession, externalDocId: string): Promise<number> {
    try {
      const rows = asRows(await this.client.call('controlPagos', { token: session.token, query: { idDocumentoPago: externalDocId } }), 'el control de pagos');
      return rows.reduce((sum, r) => sum + (moneyToCents(r['importe']) ?? 0), 0);
    } catch (error) {
      if (error instanceof ApiworkingError && error.kind === 'REJECTED') return 0;
      throw error;
    }
  }

  private async settleFailure(id: string, error: unknown, principal: AuthPrincipal, meta: RequestMeta): Promise<SaleRow> {
    const kind = error instanceof ApiworkingError ? error.kind : 'UNKNOWN_RESULT';
    // Solo los NOMBRES de los campos recibidos (nunca valores): sirve para ajustar el contrato con Apiworking.
    if (error instanceof ApiworkingError && kind === 'BAD_RESPONSE') this.diag.warn(`registro-documento sin forma esperada: ${error.message}`);
    // Duplicado (409), respuesta incompleta o tiempo agotado: puede existir en Apiworking -> conciliación humana.
    const unknown = kind === 'UNKNOWN_RESULT' || kind === 'DUPLICATE' || kind === 'BAD_RESPONSE';
    const reason = unknown ? 'Resultado desconocido: Apiworking pudo registrar el documento. Verifique antes de reenviar' : error instanceof ApiworkingError ? error.message : 'Rechazado';
    // Una venta de contingencia rechazada vuelve a «por emitir»: el dinero ya está en la caja local y se puede corregir y emitir.
    const wasContingency = (await this.db.apiworkingSale.findUnique({ where: { id }, select: { contingency: true } }))?.contingency ?? false;
    const sale = await this.settle(id, { docStatus: unknown ? 'PENDING_RECONCILIATION' : wasContingency ? 'PENDING_ISSUE' : 'REJECTED', failureReason: clip(reason) });
    await this.log(unknown ? AuditAction.ApiworkingSaleUnknown : AuditAction.ApiworkingSaleRejected, sale, principal, meta, { kind });
    return sale;
  }

  private settle(id: string, data: Prisma.ApiworkingSaleUpdateInput) {
    return this.db.apiworkingSale.update({ where: { id }, data });
  }

  private log(action: string, sale: SaleRow, principal: AuthPrincipal, meta: RequestMeta, extra: Record<string, unknown>) {
    return this.audit.recordSafely({
      action,
      entity: 'ApiworkingSale',
      entityId: sale.id,
      userId: principal.user.id,
      clinicId: sale.clinicId,
      patientId: sale.patientId,
      meta,
      summary: { totalCents: sale.totalCents, status: sale.docStatus, externalDocId: sale.externalDocId, ...extra },
    });
  }

  // --- Consulta, verificación y conciliación ---

  /** Filtro del historial: días de Lima (ambos incluidos) y texto en cliente, documento, comprobante o detalle. */
  private historyWhere(clinicId: string, q: { from?: string; to?: string; search?: string }): Prisma.ApiworkingSaleWhereInput {
    const createdAt: { gte?: Date; lt?: Date } = {};
    if (q.from) createdAt.gte = new Date(`${q.from}T00:00:00-05:00`);
    if (q.to) createdAt.lt = new Date(new Date(`${q.to}T00:00:00-05:00`).getTime() + 86_400_000);
    const s = q.search?.trim();
    return {
      clinicId,
      ...(q.from || q.to ? { createdAt } : {}),
      ...(s ? { OR: [{ customerName: { contains: s } }, { customerDocNumber: { contains: s } }, { externalNumber: { contains: s } }, { description: { contains: s } }] } : {}),
    };
  }

  async list(principal: AuthPrincipal, q: { limit: number; offset: number; from?: string; to?: string; search?: string }, meta?: RequestMeta) {
    const { clinicId } = clinicScope(principal);
    const where = this.historyWhere(clinicId, q);
    const [rows, total] = await Promise.all([
      this.db.apiworkingSale.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit, skip: q.offset }),
      this.db.apiworkingSale.count({ where }),
    ]);
    // Las ventas con número por confirmar se buscan solas en Apiworking (como mucho 3 por listado y cada 2 minutos).
    if (meta && this.config.apiworking.read && this.clients.hasSession(principal)) {
      const due = rows.filter((r) => r.docStatus === 'PENDING_RECONCILIATION' && Date.now() - (this.located.get(r.id) ?? 0) > LOCATE_EVERY_MS).slice(0, 3);
      for (const r of due) rows[rows.indexOf(r)] = await this.locate(r, principal, meta);
    }
    return { items: rows.map(presentSale), total };
  }

  /**
   * Resumen de ventas de un día (hora de Lima) por forma de pago, para la caja chica. Cuenta lo enviado o por conciliar:
   * las rechazadas no son ventas. Los nombres de las formas de pago salen de las cajas abiertas, si Apiworking responde.
   */
  async summary(principal: AuthPrincipal, day?: string) {
    const { clinicId } = clinicScope(principal);
    const date = day ?? limaToday();
    const from = new Date(`${date}T00:00:00-05:00`);
    const to = new Date(from.getTime() + 24 * 3600 * 1000);
    const rows = await this.db.apiworkingSale.findMany({
      where: { clinicId, createdAt: { gte: from, lt: to }, docStatus: { not: 'REJECTED' }, voidStatus: null },
      select: { paymentMethodId: true, totalCents: true, payments: true, docStatus: true, contingency: true },
    });
    const names = await this.methodNames(principal);
    const by = new Map<string, { methodId: string; name: string; count: number; totalCents: number }>();
    // Una venta pagada con varios medios suma cada parte a su medio (y cuenta como venta en cada uno).
    for (const r of rows) {
      for (const p of paymentsOf(r)) {
        const cur = by.get(p.idMetodoPago) ?? { methodId: p.idMetodoPago, name: names.get(p.idMetodoPago) ?? `Forma de pago ${p.idMetodoPago}`, count: 0, totalCents: 0 };
        cur.count += 1; cur.totalCents += p.amountCents;
        by.set(p.idMetodoPago, cur);
      }
    }
    const methods = [...by.values()].sort((a, b) => b.totalCents - a.totalCents).map((m) => ({ ...m, totalText: money(m.totalCents) }));
    const totalCents = rows.reduce((t, r) => t + r.totalCents, 0);
    return { date, count: rows.length, totalCents, totalText: money(totalCents), methods };
  }

  /** Nombres de las formas de pago (de las cajas abiertas), si Apiworking responde; si no, se muestra el id. */
  private async methodNames(principal: AuthPrincipal): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const session = this.clients.requireSession(principal);
      const cajas = asRows(await this.client.call('caja', { token: session.token }), 'las cajas').map(cajaId).filter((id) => allowed(this.config.apiworking.authorizedCashRegisters, id));
      for (const id of cajas) {
        const opened = await this.openMovement(session, id);
        if (opened) for (const m of await this.paymentMethods(session, opened)) names.set(m.id, m.name);
      }
    } catch { /* sin nombres: se muestra el id */ }
    return names;
  }

  /**
   * Historial de ventas exportable (Excel o PDF) con los mismos filtros de la lista. Como máximo 5000 ventas por archivo. Se audita
   * la exportación (filtros y cantidad), nunca su contenido.
   */
  async exportHistory(principal: AuthPrincipal, q: { from?: string; to?: string; search?: string; format: 'xlsx' | 'pdf' }, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(principal);
    const rows = await this.db.apiworkingSale.findMany({ where: this.historyWhere(clinicId, q), orderBy: { createdAt: 'asc' }, take: 5000 });
    const names = rows.length ? await this.methodNames(principal) : new Map<string, string>();
    const methodLabel = (id: string) => (id ? (names.get(id) ?? `Forma de pago ${id}`) : 'Contingencia (caja local)');
    const when = (d: Date) => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    const header = ['Fecha', 'Comprobante', 'Cliente', 'Documento', 'Detalle', 'Forma de pago', 'Descuento (S/)', 'Total (S/)', 'Estado', 'Cobro', 'Anulación'];
    const table = rows.map((r) => [
      when(r.createdAt),
      r.externalNumber ?? '',
      r.customerName,
      `${r.customerDocType} ${r.customerDocNumber}`.trim(),
      r.description,
      paymentsOf(r).map((p) => `${methodLabel(p.idMetodoPago)} ${money(p.amountCents)}`).join(' + '),
      r.discountCents / 100,
      r.totalCents / 100,
      DOC_LABELS[r.docStatus],
      PAYMENT_LABELS[r.paymentStatus],
      r.voidStatus ? VOID_LABELS[r.voidStatus] : '',
    ]);
    // El total del período: solo lo vendido de verdad (sin rechazadas ni anuladas).
    const counted = rows.filter((r) => r.docStatus !== 'REJECTED' && r.voidStatus === null);
    const totalCents = counted.reduce((t, r) => t + r.totalCents, 0);
    const period = `${q.from ?? 'inicio'}_${q.to ?? limaToday()}`;
    await this.audit.recordSafely({ action: 'APIWORKING_SALES_EXPORTED', entity: 'ApiworkingSale', userId: principal.user.id, clinicId, branchId, meta, summary: { format: q.format, from: q.from ?? null, to: q.to ?? null, search: Boolean(q.search), count: rows.length } });
    if (q.format === 'xlsx') {
      const body = buildXlsx('Ventas', header, [...table, [], ['Total vendido', '', '', '', `${counted.length} ventas`, '', '', totalCents / 100, '', '', '']]);
      return { body, filename: `ventas_${period}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    const body = await renderSalesPdf({ title: 'Historial de ventas', period: `${q.from ?? 'Desde el inicio'} — ${q.to ?? limaToday()}`, header, rows: table.map((r) => r.map((c, i) => (i === 6 || i === 7 ? money(Math.round(Number(c) * 100)) : String(c)))), total: `${counted.length} ventas · Total vendido ${money(totalCents)}` });
    return { body, filename: `ventas_${period}.pdf`, type: 'application/pdf' };
  }

  /**
   * Datos para imprimir la venta (A4 o ticket): la venta, la clínica (nombre, razón social, RUC), la sede y los nombres de las formas
   * de pago. La impresión es una representación interna; la representación oficial (con QR) es el PDF de Apiworking.
   */
  async printData(principal: AuthPrincipal, id: string) {
    const sale = await this.load(principal, id);
    const { branchId } = clinicScope(principal);
    const [clinic, branch, user, names] = await Promise.all([
      this.db.clinic.findUnique({ where: { id: sale.clinicId }, select: { name: true, legalName: true, ruc: true, brandDisplayName: true } }),
      branchId ? this.db.branch.findUnique({ where: { id: branchId }, select: { name: true, address: true } }) : Promise.resolve(null),
      this.db.user.findUnique({ where: { id: sale.createdById }, select: { firstName: true, lastName: true } }),
      this.methodNames(principal),
    ]);
    const letter = (sale.serie ?? '').trim().charAt(0).toUpperCase();
    const documentLabel = sale.contingency && sale.docStatus === 'PENDING_ISSUE' ? 'Comprobante interno (por emitir)' : letter === 'F' ? 'Factura electrónica' : letter === 'B' ? 'Boleta de venta electrónica' : 'Nota de venta';
    // Precios con IGV incluido (aplicaIGV = 1): op. gravada = total / 1.18.
    const taxable = Math.round(sale.totalCents / 1.18);
    return {
      sale: presentSale(sale),
      documentLabel,
      clinic: { name: clinic?.brandDisplayName || clinic?.name || '', legalName: clinic?.legalName ?? null, ruc: clinic?.ruc ?? null },
      branch: branch ? { name: branch.name, address: branch.address } : null,
      cashier: user ? `${user.firstName} ${user.lastName}`.trim() : null,
      payments: paymentsOf(sale).map((p) => ({ name: p.idMetodoPago ? (names.get(p.idMetodoPago) ?? `Forma de pago ${p.idMetodoPago}`) : 'Caja local', amountCents: p.amountCents })),
      grossCents: sale.totalCents + sale.discountCents,
      taxableCents: taxable,
      igvCents: sale.totalCents - taxable,
    };
  }

  /** URL del PDF oficial del comprobante en Apiworking (urlComprobante). Solo para ventas registradas con su id de documento. */
  async officialUrl(principal: AuthPrincipal, id: string) {
    const sale = await this.load(principal, id);
    if (sale.docStatus !== 'SENT' || !sale.externalDocId) throw new ConflictException({ message: 'La venta aún no tiene un comprobante registrado en Apiworking', code: 'NO_DOCUMENT' });
    const session = this.clients.requireSession(principal);
    const data = await this.client.call('urlComprobante', { token: session.token, query: { bd: this.config.apiworking.expectedDatabase!, idDocumento: sale.externalDocId } });
    const url = typeof data === 'string' ? data.trim() : '';
    if (!/^https:\/\/[^\s]+$/i.test(url)) throw new ServiceUnavailableException({ message: 'Apiworking no devolvió el enlace del comprobante', code: 'NO_URL' });
    return { url };
  }

  private async load(principal: AuthPrincipal, id: string): Promise<SaleRow> {
    const { clinicId } = clinicScope(principal);
    const sale = await this.db.apiworkingSale.findFirst({ where: { id, clinicId } });
    if (!sale) throw new NotFoundException('Venta no encontrada');
    return sale;
  }

  async get(principal: AuthPrincipal, id: string) {
    return presentSale(await this.load(principal, id));
  }

  /**
   * Consulta en Apiworking sin decidir por la persona: confirma el cobro SOLO si `controlPagos` cubre el total, y para
   * un resultado desconocido devuelve candidatos (mismo total y fecha) para que la persona concilie con evidencia.
   */
  async verify(principal: AuthPrincipal, id: string, meta: RequestMeta) {
    const sale = await this.load(principal, id);
    const session = this.clients.requireSession(principal);
    const result: Record<string, unknown> = {};
    let current = sale;

    if (sale.docStatus === 'SENT' && sale.externalDocId) {
      try {
        const rows = asRows(await this.client.call('controlPagos', { token: session.token, query: { idDocumentoPago: sale.externalDocId } }), 'el control de pagos');
        const paid = rows.reduce((sum, r) => sum + (moneyToCents(r['importe']) ?? 0), 0);
        result['paidCents'] = paid;
        if (paid >= sale.totalCents && sale.paymentStatus === 'NO_EVIDENCE') current = await this.settle(sale.id, { paymentStatus: 'CONFIRMED_REMOTE' });
      } catch (error) {
        if (!(error instanceof ApiworkingError) || error.kind !== 'REJECTED') throw error;
        // «No se pudo encontrar pagos»: el cobro sigue sin evidencia (problema conocido de Apiworking).
        result['paymentMessage'] = error.message;
      }
    }

    if (sale.docStatus === 'PENDING_RECONCILIATION' || sale.docStatus === 'PENDING' || sale.voidStatus === 'IN_PROGRESS') {
      const day = dmy(sale.docDate.toISOString().slice(0, 10));
      // Apiworking puede fechar el documento con el día UTC (una venta de noche en Lima queda al día siguiente): se busca hasta ese día.
      const nextDay = dmy(new Date(sale.docDate.getTime() + 86_400_000).toISOString().slice(0, 10));
      const rows = asRows(
        await this.client.call('facturacion', {
          token: session.token,
          query: { idSucursal: session.branchId ?? undefined, fechaInicio: day, fechaFin: nextDay, displayStart: 1, displayLength: 100, allFechas: 0, search: sale.externalNumber ?? undefined },
        }),
        'los documentos',
      );
      const taken = new Set((await this.db.apiworkingSale.findMany({ where: { tenant: sale.tenant, externalNumber: { not: null }, NOT: { id: sale.id } }, select: { externalNumber: true } })).map((s) => s.externalNumber));
      const found = rows.map((r) => ({ number: optText(r, 'nroComprobante'), status: optText(r, 'estado'), totalCents: moneyToCents(r['totalVenta']), balanceCents: moneyToCents(r['monto_saldo']) }));
      if (sale.voidStatus === 'IN_PROGRESS') {
        const mine = found.find((f) => f.number && f.number === sale.externalNumber);
        if (mine && /anul/i.test(mine.status)) current = await this.settle(sale.id, { voidStatus: 'VOIDED' });
        result['document'] = mine ?? null;
      } else {
        result['candidates'] = found.filter((f) => f.number && f.totalCents === sale.totalCents && !taken.has(f.number));
      }
    }
    await this.audit.recordSafely({ action: 'APIWORKING_SALE_VERIFIED', entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId: sale.clinicId, meta, summary: { status: current.docStatus, payment: current.paymentStatus } });
    return { sale: presentSale(current), ...result };
  }

  /** Decisión HUMANA con evidencia sobre un resultado desconocido. Nunca reenvía nada a Apiworking. */
  async reconcile(principal: AuthPrincipal, id: string, dto: ReconcileSaleDto, meta: RequestMeta) {
    const sale = await this.load(principal, id);
    if (sale.docStatus !== 'PENDING_RECONCILIATION' && sale.docStatus !== 'PENDING') throw new ConflictException('Solo se concilia una venta con resultado desconocido');
    if (dto.outcome === 'REGISTERED' && !dto.externalNumber) throw new UnprocessableEntityException('Indique el número de comprobante que verificó en Apiworking');
    const updated = await this.settle(sale.id, dto.outcome === 'REGISTERED'
      ? { docStatus: 'SENT', externalNumber: dto.externalNumber, externalDocId: dto.externalDocId ?? null, failureReason: null }
      : { docStatus: 'REJECTED', failureReason: clip(`Conciliado: no existe en Apiworking. ${dto.note}`) });
    if (updated.docStatus === 'REJECTED') await releaseServices(this.db, updated.id);
    await this.audit.recordSafely({ action: AuditAction.ApiworkingSaleReconciled, entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId: sale.clinicId, meta, summary: { outcome: dto.outcome, note: clip(dto.note) } });
    return presentSale(updated);
  }

  // --- Pago del documento ---

  /**
   * Aplica en Apiworking el pago de un documento ya registrado (registro-documento no lo aplica). La persona confirma monto y
   * forma de pago en pantalla; se envía UNA vez, con tope, y el intento se guarda ANTES de llamar. Un resultado dudoso no se
   * reintenta: se comprueba con «Verificar» (controlPagos).
   */
  async pay(principal: AuthPrincipal, id: string, meta: RequestMeta) {
    return presentSale(await this.applyPayment(await this.load(principal, id), principal, meta));
  }

  /** `auto`: pago aplicado en el mismo paso que la venta (ya pasó el tope al registrarla). */
  private async applyPayment(sale: SaleRow, principal: AuthPrincipal, meta: RequestMeta, auto = false): Promise<SaleRow> {
    const cfg = this.config.apiworking;
    if (!cfg.write) throw new ServiceUnavailableException({ message: 'Las escrituras reales de Apiworking están desactivadas en esta instalación', code: 'WRITE_DISABLED' });
    if (sale.docStatus !== 'SENT' || !sale.externalDocId) throw new ConflictException('Solo se registra el pago de una venta ya registrada en Apiworking');
    if (sale.voidStatus !== null) throw new ConflictException('La venta tiene una anulación: no se registra su pago');
    if (sale.paymentStatus !== 'NO_EVIDENCE') throw new ConflictException('El pago de esta venta ya está confirmado');
    const [attempts, rejected] = await Promise.all([
      this.db.auditLog.count({ where: { entity: 'ApiworkingSale', entityId: sale.id, action: AuditAction.ApiworkingPaymentAttempt } }),
      this.db.auditLog.count({ where: { entity: 'ApiworkingSale', entityId: sale.id, action: AuditAction.ApiworkingPaymentRejected } }),
    ]);
    if (attempts > rejected) throw new ConflictException({ message: 'Ya se envió el pago de esta venta y el resultado no está confirmado. Use «Verificar» antes de intentarlo de nuevo.', code: 'PAYMENT_ALREADY_SENT' });
    const session = this.clients.requireSession(principal);
    if (!auto) await enforceRealOperationsCap(this.db, this.config);

    // registrar-pago acepta una lista: con varios medios va una entrada por medio (la guía no lo da por probado).
    const body = { idDocumentoPago: Number(sale.externalDocId), cadenaPago: paymentsOf(sale).map((p) => ({ idMetodoPago: p.idMetodoPago, importePago: p.amountCents / 100 })), vuelto: 0 };
    if (!Number.isSafeInteger(body.idDocumentoPago)) throw new ConflictException('El id del documento en Apiworking no es numérico');
    const log = (action: string, extra: Record<string, unknown>) =>
      this.audit.recordSafely({ action, entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId: sale.clinicId, patientId: sale.patientId, meta, summary: { totalCents: sale.totalCents, ...extra } });
    await this.audit.record({ action: AuditAction.ApiworkingPaymentAttempt, entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId: sale.clinicId, patientId: sale.patientId, meta, summary: { totalCents: sale.totalCents, auto } });

    try {
      const r = asResult(await this.client.call('registrarPago', { token: session.token, body }), 'el registro del pago');
      const hasError = r['error'] !== null && r['error'] !== undefined && r['error'] !== '';
      if ((r['result'] !== 1 && r['result'] !== '1') || hasError) {
        await log(AuditAction.ApiworkingPaymentUnknown, { reason: 'unexpected_shape' });
        throw new ConflictException({ message: 'Apiworking respondió sin la forma esperada: use «Verificar» para comprobar si el pago quedó aplicado.', code: 'PAYMENT_UNCONFIRMED' });
      }
      await log(AuditAction.ApiworkingPaymentRegistered, {});
      return await this.settle(sale.id, { paymentStatus: 'CONFIRMED_REMOTE', failureReason: null });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      const kind = error instanceof ApiworkingError ? error.kind : 'UNKNOWN_RESULT';
      if (error instanceof ApiworkingError && !['UNKNOWN_RESULT', 'DUPLICATE', 'BAD_RESPONSE'].includes(kind)) {
        await log(AuditAction.ApiworkingPaymentRejected, { kind });
        throw new ConflictException({ message: error.message, code: 'PAYMENT_REJECTED' });
      }
      await log(AuditAction.ApiworkingPaymentUnknown, { kind });
      throw new ConflictException({ message: 'No se pudo confirmar el pago: pudo aplicarse. Use «Verificar» antes de intentarlo de nuevo.', code: 'PAYMENT_UNCONFIRMED' });
    }
  }

  // --- Anulación ---

  async voidSale(principal: AuthPrincipal, id: string, reason: string, meta: RequestMeta) {
    const cfg = this.config.apiworking;
    if (!cfg.write) throw new ServiceUnavailableException({ message: 'Las escrituras reales de Apiworking están desactivadas en esta instalación', code: 'WRITE_DISABLED' });
    const sale = await this.load(principal, id);
    if (sale.docStatus !== 'SENT' || !sale.externalDocId) throw new ConflictException('Solo se anula una venta registrada en Apiworking');
    if (sale.voidStatus === 'VOIDED' || sale.voidStatus === 'IN_PROGRESS') throw new ConflictException('La venta ya tiene una anulación en curso o terminada');
    const session = this.clients.requireSession(principal);
    const recent = await this.db.apiworkingSale.count({ where: { tenant: sale.tenant, attemptedAt: { gte: new Date(Date.now() - WINDOW_MS) } } });
    if (cfg.maxRealOperations > 0 && recent >= cfg.maxRealOperations) throw new ConflictException({ message: 'Se alcanzó el tope de envíos reales en 24 horas', code: 'REAL_OPERATIONS_LIMIT' });

    let updated: SaleRow;
    try {
      await this.client.call('anular', { token: session.token, query: { idDocumentoPago: sale.externalDocId, motivoAnulacion: reason, usuario: session.username } });
      // result 1 o 3 sin significado confirmado: «en curso» hasta verificar en Apiworking.
      updated = await this.settle(sale.id, { voidStatus: 'IN_PROGRESS', attemptedAt: new Date() });
    } catch (error) {
      const unknown = !(error instanceof ApiworkingError) || ['UNKNOWN_RESULT', 'BAD_RESPONSE'].includes(error.kind);
      if (!unknown) throw error instanceof ApiworkingError ? new ConflictException({ message: error.message, code: 'VOID_REJECTED' }) : error;
      updated = await this.settle(sale.id, { voidStatus: 'TO_RECONCILE', attemptedAt: new Date() });
    }
    await this.audit.recordSafely({ action: AuditAction.ApiworkingSaleVoided, entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId: sale.clinicId, meta, summary: { voidStatus: updated.voidStatus, reason: clip(reason) } });
    return presentSale(updated);
  }
}

/** Sugerencia de comprobante: RUC a Factura, DNI a Boleta y otro caso a Nota de Venta (decisión de AGUA SALOMÓN). */
export function suggestDocument(docType: string): 'FACTURA' | 'BOLETA' | 'NOTA_DE_VENTA' {
  const t = docType.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (t.startsWith('RUC')) return 'FACTURA';
  if (t.startsWith('DNI')) return 'BOLETA';
  return 'NOTA_DE_VENTA';
}
