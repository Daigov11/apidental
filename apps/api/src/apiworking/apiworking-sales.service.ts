import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { clinicScope, isUniqueViolation, requirePatient } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ApiworkingClient, ApiworkingError, asRecord, asRows, cajaId, cajaName, allowed, clip, isNoData, moneyToCents, optText, reqId } from './apiworking.client.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import type { ExternalSession } from './apiworking-session.store.js';
import type { ReconcileSaleDto, SaleDraftDto } from './dto/apiworking.dto.js';

type SaleRow = Prisma.ApiworkingSaleGetPayload<object>;

const DOC_LABELS = { PENDING: 'Enviando', SENT: 'Registrado en Apiworking', REJECTED: 'Rechazado', PENDING_RECONCILIATION: 'Resultado desconocido: conciliar' } as const;
const PAYMENT_LABELS = { NO_EVIDENCE: 'Cobro sin confirmar', CONFIRMED_REMOTE: 'Cobro confirmado en Apiworking', CONFIRMED_RECONCILED: 'Cobro conciliado' } as const;
const VOID_LABELS = { IN_PROGRESS: 'Anulación en curso', VOIDED: 'Anulado', TO_RECONCILE: 'Anulación por conciliar' } as const;
/** Unidad de medida por defecto: «1» = NIU (según el responsable del tenant). */
const DEFAULT_UNIT = '1';
/** Almacén = sucursal del login de Apiworking (`id_sucursal`); el .env solo lo sobrescribe si hace falta. */
const warehouseOf = (cfg: { warehouseId: string | null }, session: ExternalSession) => cfg.warehouseId ?? session.branchId;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Nombre legible de una fila: el contrato no lo fija, se usa el primer campo conocido que exista. */
const label = (r: Record<string, unknown>, keys: string[], fallback: string) => keys.map((k) => optText(r, k)).find(Boolean) ?? fallback;
const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const limaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
/** 2026-08-20 -> 20-08-2026 (formato de fechas de Apiworking, sin zona horaria). */
const dmy = (iso: string) => iso.split('-').reverse().join('-');

export function presentSale(s: SaleRow) {
  return {
    id: s.id,
    description: s.description,
    customer: { name: s.customerName, docType: s.customerDocType, docNumber: s.customerDocNumber },
    totalCents: s.totalCents,
    totalText: money(s.totalCents),
    lines: s.lines,
    docDate: s.docDate.toISOString().slice(0, 10),
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
      verify: s.docStatus === 'SENT' || s.docStatus === 'PENDING_RECONCILIATION' || s.voidStatus === 'IN_PROGRESS',
      reconcile: s.docStatus === 'PENDING_RECONCILIATION' || s.docStatus === 'PENDING',
      void: s.docStatus === 'SENT' && (s.voidStatus === null || s.voidStatus === 'TO_RECONCILE'),
    },
  };
}

/**
 * Ventas por `registro-documento` de Apiworking. Reglas (guía de integración): una escritura real puede tener efecto
 * tributario, así que cada envío (1) exige que la persona apruebe el JSON exacto (SHA-256), (2) se hace UNA sola vez y sin
 * reintentos, (3) respeta un tope de envíos por 24 h, (4) separa documento, cobro y anulación como estados distintos
 * (registrar el documento NO aplica el pago) y (5) trata un tiempo agotado como resultado DESCONOCIDO: se concilia a mano.
 */
@Injectable()
export class ApiworkingSalesService {
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
      warnings: [
        'Apiworking registra el documento, pero NO aplica el cobro: el cobro quedará «sin confirmar» hasta verificarlo.',
        'Una Boleta o Factura real puede llegar a SUNAT. Revise el JSON antes de aprobarlo.',
      ],
    };
  }

  private async build(principal: AuthPrincipal, draft: SaleDraftDto) {
    const cfg = this.config.apiworking;
    const session = this.clients.requireSession(principal);
    if (!allowed(cfg.authorizedCashRegisters, draft.idCaja) || !allowed(cfg.authorizedDocumentTypes, draft.idTipoDocumento) || !allowed(cfg.authorizedSeries, draft.idSerie)) {
      throw new BadRequestException('La caja, el tipo de documento o la serie no están autorizados para esta instalación');
    }
    const warehouse = warehouseOf(cfg, session);
    const unit = cfg.unitId ?? DEFAULT_UNIT;
    if (!warehouse || !Number.isSafeInteger(Number(warehouse))) throw new ServiceUnavailableException('Apiworking no informó la sucursal (id_sucursal) del usuario: no se puede determinar el almacén');
    for (const id of [draft.customerId, draft.idSerie]) {
      if (!Number.isSafeInteger(Number(id))) throw new BadRequestException('Identificador de Apiworking fuera de rango');
    }
    const customer = await this.clients.find(principal, draft.customerId);
    if (!customer) throw new BadRequestException('El cliente no existe (o está inactivo) en Apiworking');

    // Se revalidan caja, tipo, serie y forma de pago en cada vista previa y en cada envío: pueden cambiar.
    const movement = await this.openMovement(session, draft.idCaja);
    if (!movement) throw new ConflictException({ message: 'La caja no tiene una apertura vigente en Apiworking', code: 'CASH_REGISTER_CLOSED' });
    if (!(await this.documentTypes(session, draft.idCaja)).some((t) => t.id === draft.idTipoDocumento)) throw new BadRequestException('El tipo de documento no corresponde a la caja');
    const serie = (await this.seriesOf(session, draft.idCaja, draft.idTipoDocumento)).find((s) => s.id === draft.idSerie);
    if (!serie) throw new BadRequestException('La serie no corresponde a la caja y al tipo de documento');
    if (!(await this.paymentMethods(session, movement)).some((m) => m.id === draft.idMetodoPago)) throw new BadRequestException('La forma de pago no está disponible en la apertura de caja');

    const totalCents = draft.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
    if (totalCents < 1 || totalCents > 1_000_000_000) throw new BadRequestException('El total de la venta está fuera de rango');
    const docDate = draft.docDate ?? limaToday();
    if (Number.isNaN(Date.parse(`${docDate}T00:00:00Z`))) throw new BadRequestException('Fecha inválida');

    const body = {
      idCaja: draft.idCaja,
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
        descuento: 0,
        descuentoImporte: 0,
        idDetalle: '',
        cadenaLotes: '',
      })),
      cadenaPago: `${draft.idMetodoPago}^${(totalCents / 100).toFixed(2)}^0~`,
      fechaDoc: docDate,
      aplicaIGV: '1',
      // El total lo calcula Apiworking; el total local se muestra y se guarda aparte.
      totalVenta: 0,
    };
    return { body, hash: sha256(JSON.stringify(body)), totalCents, customer, serie: serie.serie, docDate };
  }

  // --- Registro: un solo envío, con aprobación, tope y sin reintentos ---

  async create(principal: AuthPrincipal, dto: SaleDraftDto & { approvedHash: string; idempotencyKey: string }, meta: RequestMeta) {
    const { clinicId } = clinicScope(principal);
    const cfg = this.config.apiworking;
    if (!cfg.write) throw new ServiceUnavailableException({ message: 'Las escrituras reales de Apiworking están desactivadas en esta instalación', code: 'WRITE_DISABLED' });

    const existing = await this.db.apiworkingSale.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      if (existing.clinicId !== clinicId || existing.requestHash !== dto.approvedHash) throw new ConflictException({ message: 'La clave de idempotencia ya se usó con otra venta', code: 'IDEMPOTENCY_MISMATCH' });
      return presentSale(existing);
    }
    if (dto.patientId) await requirePatient(this.db, clinicId, dto.patientId);

    const built = await this.build(principal, dto);
    if (built.hash !== dto.approvedHash) throw new ConflictException({ message: 'La venta cambió después de la vista previa: revise y apruebe de nuevo', code: 'PREVIEW_CHANGED' });

    const tenant = cfg.expectedDatabase!;
    const recent = await this.db.apiworkingSale.count({ where: { tenant, attemptedAt: { gte: new Date(Date.now() - WINDOW_MS) } } });
    if (recent >= cfg.maxRealOperations) {
      throw new ConflictException({ message: `Se alcanzó el tope de ${cfg.maxRealOperations} envíos reales en 24 horas (APIWORKING_MAX_REAL_OPERATIONS)`, code: 'REAL_OPERATIONS_LIMIT' });
    }

    let sale: SaleRow;
    try {
      // La fila nace ANTES de llamar a Apiworking, con la marca de intento: si el proceso muere a mitad, queda constancia.
      sale = await this.db.apiworkingSale.create({
        data: {
          clinicId,
          tenant,
          idempotencyKey: dto.idempotencyKey,
          requestHash: built.hash,
          patientId: dto.patientId ?? null,
          externalCustomerId: built.customer.id,
          customerName: built.customer.name.slice(0, 200),
          customerDocType: built.customer.docType.slice(0, 20),
          customerDocNumber: built.customer.docNumber.slice(0, 20),
          idCaja: dto.idCaja,
          idSerie: dto.idSerie,
          serie: built.serie,
          documentTypeId: dto.idTipoDocumento,
          paymentMethodId: dto.idMetodoPago,
          description: dto.description,
          lines: dto.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
          totalCents: built.totalCents,
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
      const r = asRecord(data, 'el registro del documento');
      const result = r['result'];
      const hasError = r['error'] !== null && r['error'] !== undefined && r['error'] !== '';
      if ((result !== 1 && result !== '1') || hasError) {
        // Respuesta 200 pero sin la forma esperada: el documento pudo registrarse. No se da por bueno ni por malo.
        updated = await this.settle(sale.id, { docStatus: 'PENDING_RECONCILIATION', failureReason: 'Respuesta de Apiworking incompleta: verifique si el documento existe' });
        await this.log(AuditAction.ApiworkingSaleUnknown, updated, principal, meta, { reason: 'unexpected_shape' });
      } else {
        updated = await this.settle(sale.id, { docStatus: 'SENT', externalDocId: reqId(r, 'idComprobante', 'el registro del documento'), externalNumber: optText(r, 'nroComprobante') || null });
        await this.log(AuditAction.ApiworkingSaleSent, updated, principal, meta, {});
      }
    } catch (error) {
      updated = await this.settleFailure(sale.id, error, principal, meta);
    }
    return presentSale(updated);
  }

  private async settleFailure(id: string, error: unknown, principal: AuthPrincipal, meta: RequestMeta): Promise<SaleRow> {
    const kind = error instanceof ApiworkingError ? error.kind : 'UNKNOWN_RESULT';
    // Duplicado (409), respuesta incompleta o tiempo agotado: puede existir en Apiworking -> conciliación humana.
    const unknown = kind === 'UNKNOWN_RESULT' || kind === 'DUPLICATE' || kind === 'BAD_RESPONSE';
    const reason = unknown ? 'Resultado desconocido: Apiworking pudo registrar el documento. Verifique antes de reenviar' : error instanceof ApiworkingError ? error.message : 'Rechazado';
    const sale = await this.settle(id, { docStatus: unknown ? 'PENDING_RECONCILIATION' : 'REJECTED', failureReason: clip(reason) });
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

  async list(principal: AuthPrincipal, q: { limit: number; offset: number }) {
    const { clinicId } = clinicScope(principal);
    const [rows, total] = await Promise.all([
      this.db.apiworkingSale.findMany({ where: { clinicId }, orderBy: { createdAt: 'desc' }, take: q.limit, skip: q.offset }),
      this.db.apiworkingSale.count({ where: { clinicId } }),
    ]);
    return { items: rows.map(presentSale), total };
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
      const rows = asRows(
        await this.client.call('facturacion', {
          token: session.token,
          query: { idSucursal: session.branchId ?? undefined, fechaInicio: day, fechaFin: day, displayStart: 1, displayLength: 100, allFechas: 0, search: sale.externalNumber ?? undefined },
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
    await this.audit.recordSafely({ action: AuditAction.ApiworkingSaleReconciled, entity: 'ApiworkingSale', entityId: sale.id, userId: principal.user.id, clinicId: sale.clinicId, meta, summary: { outcome: dto.outcome, note: clip(dto.note) } });
    return presentSale(updated);
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
    if (recent >= cfg.maxRealOperations) throw new ConflictException({ message: 'Se alcanzó el tope de envíos reales en 24 horas', code: 'REAL_OPERATIONS_LIMIT' });

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
