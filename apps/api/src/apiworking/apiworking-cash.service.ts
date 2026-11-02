import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Inject, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import { clinicScope } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ApiworkingClient, ApiworkingError, asRows, cajaId, cajaName, clip, isNoData, optText, reqId } from './apiworking.client.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import type { CashCloseDraftDto, CashOpenDraftDto } from './dto/apiworking.dto.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TURN = '1';
/** Moneda 1 = soles (idMoneda del detalle "idMoneda^monto"). */
const SOLES = '1';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const amountText = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const soles = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;

/**
 * Apertura de caja (`AperturaCajaChica`). Escritura real: exige que la persona apruebe el JSON exacto (SHA-256), se envía UNA vez
 * sin reintentos, cuenta en el tope de envíos de 24 h, nunca abre una caja ya abierta y verifica el resultado con
 * `consulta-aperturada`. Un resultado dudoso NO se reenvía: se comprueba el estado de la caja.
 */
@Injectable()
export class ApiworkingCashService {
  /** Evita dos aperturas simultáneas de la misma caja dentro de esta instancia. */
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly config: AppConfig,
    private readonly client: ApiworkingClient,
    private readonly clients: ApiworkingClientsService,
    private readonly audit: AuditService,
  ) {}

  /** Cajas autorizadas con su estado (abierta o cerrada) y los turnos que informa Apiworking. */
  async status(principal: AuthPrincipal) {
    const session = this.clients.requireSession(principal);
    const cfg = this.config.apiworking;
    const cajas = asRows(await this.client.call('caja', { token: session.token }), 'las cajas')
      .filter((r) => cfg.authorizedCashRegisters.includes(cajaId(r)))
      .map((r) => ({ id: cajaId(r), name: cajaName(r), branch: optText(r, 'sucursal') }));
    const withState = [];
    for (const c of cajas) withState.push({ ...c, opened: (await this.openMovement(session.token, c.id)) !== null });
    return { cajas: withState, turnos: await this.turns(session.token), defaultTurn: DEFAULT_TURN, write: cfg.write };
  }

  async preview(principal: AuthPrincipal, draft: CashOpenDraftDto) {
    const built = await this.build(principal, draft);
    return { hash: built.hash, caja: built.cajaName, turn: built.turn, openingCents: draft.openingCents, openingText: soles(draft.openingCents), alreadyOpen: built.alreadyOpen, write: this.config.apiworking.write };
  }

  async open(principal: AuthPrincipal, dto: CashOpenDraftDto & { approvedHash: string }, meta: RequestMeta) {
    const { clinicId } = clinicScope(principal);
    const cfg = this.config.apiworking;
    if (!cfg.write) throw new ServiceUnavailableException({ message: 'Las escrituras reales de Apiworking están desactivadas en esta instalación', code: 'WRITE_DISABLED' });
    if (this.inFlight.has(dto.idCaja)) throw new ConflictException({ message: 'Ya hay una apertura de esta caja en curso', code: 'IN_PROGRESS' });
    this.inFlight.add(dto.idCaja);
    try {
      const built = await this.build(principal, dto);
      if (built.hash !== dto.approvedHash) throw new ConflictException({ message: 'La apertura cambió después de la vista previa: revise y apruebe de nuevo', code: 'PREVIEW_CHANGED' });
      if (built.alreadyOpen) throw new ConflictException({ message: 'La caja ya está abierta en Apiworking', code: 'ALREADY_OPEN' });

      await this.enforceCap();

      const log = (action: string, extra: Record<string, unknown>) =>
        this.audit.recordSafely({ action, entity: 'ApiworkingCash', entityId: dto.idCaja, userId: principal.user.id, clinicId, meta, summary: { idCaja: dto.idCaja, openingCents: dto.openingCents, turn: built.turn, ...extra } });
      // Constancia ANTES de llamar: cuenta para el tope aunque el proceso muera a mitad. Si no se puede guardar, no se envía.
      await this.audit.record({ action: AuditAction.ApiworkingCashOpenAttempt, entity: 'ApiworkingCash', entityId: dto.idCaja, userId: principal.user.id, clinicId, meta, summary: { idCaja: dto.idCaja, openingCents: dto.openingCents, turn: built.turn } });

      const session = this.clients.requireSession(principal);
      let providerNote = '';
      try {
        const data = await this.client.call('aperturaCaja', { token: session.token, body: built.body });
        const row = asRows(data, 'la apertura de caja')[0] ?? {};
        providerNote = optText(row, 'duplicado') === '1' ? 'Apiworking marcó el resultado como duplicado: se comprobó el estado real de la caja' : '';
      } catch (error) {
        const kind = error instanceof ApiworkingError ? error.kind : 'UNKNOWN_RESULT';
        if (kind === 'UNKNOWN_RESULT' || kind === 'DUPLICATE' || kind === 'BAD_RESPONSE') {
          await log(AuditAction.ApiworkingCashOpenUnknown, { kind });
          return { status: 'UNKNOWN' as const, message: 'No se pudo confirmar la apertura: la caja pudo abrirse. NO la envíe de nuevo; compruebe el estado de la caja.' };
        }
        await log(AuditAction.ApiworkingCashOpenRejected, { kind });
        throw new UnprocessableEntityException({ message: error instanceof ApiworkingError ? clip(error.message) : 'Apiworking rechazó la apertura', code: 'REJECTED' });
      }

      const movement = await this.openMovement(session.token, dto.idCaja).catch(() => null);
      if (movement) {
        await log(AuditAction.ApiworkingCashOpened, { movement });
        return { status: 'OPENED' as const, message: 'Caja abierta', movementId: movement, note: providerNote };
      }
      await log(AuditAction.ApiworkingCashOpenUnknown, { kind: 'NOT_CONFIRMED' });
      return { status: 'UNCONFIRMED' as const, message: 'Apiworking respondió que abrió la caja, pero no aparece como abierta. Compruebe su estado antes de reintentar.' };
    } finally {
      this.inFlight.delete(dto.idCaja);
    }
  }

  /** Cierre: el proveedor lo espera con las cadenas de cuadre vacías (así lo confirmó el responsable de Apiworking). */
  async closePreview(principal: AuthPrincipal, draft: CashCloseDraftDto) {
    const b = await this.buildClose(principal, draft);
    return { hash: b.hash, caja: b.cajaName, turn: b.turn, isOpen: b.isOpen, write: this.config.apiworking.write };
  }

  async close(principal: AuthPrincipal, dto: CashCloseDraftDto & { approvedHash: string }, meta: RequestMeta) {
    const { clinicId } = clinicScope(principal);
    const cfg = this.config.apiworking;
    if (!cfg.write) throw new ServiceUnavailableException({ message: 'Las escrituras reales de Apiworking están desactivadas en esta instalación', code: 'WRITE_DISABLED' });
    if (this.inFlight.has(dto.idCaja)) throw new ConflictException({ message: 'Ya hay una operación de esta caja en curso', code: 'IN_PROGRESS' });
    this.inFlight.add(dto.idCaja);
    try {
      const built = await this.buildClose(principal, dto);
      if (built.hash !== dto.approvedHash) throw new ConflictException({ message: 'El cierre cambió después de la vista previa: revise y apruebe de nuevo', code: 'PREVIEW_CHANGED' });
      if (!built.isOpen) throw new ConflictException({ message: 'La caja no está abierta en Apiworking', code: 'NOT_OPEN' });
      await this.enforceCap();

      const log = (action: string, extra: Record<string, unknown>) =>
        this.audit.recordSafely({ action, entity: 'ApiworkingCash', entityId: dto.idCaja, userId: principal.user.id, clinicId, meta, summary: { idCaja: dto.idCaja, turn: built.turn, ...extra } });
      await this.audit.record({ action: AuditAction.ApiworkingCashCloseAttempt, entity: 'ApiworkingCash', entityId: dto.idCaja, userId: principal.user.id, clinicId, meta, summary: { idCaja: dto.idCaja, turn: built.turn } });

      const session = this.clients.requireSession(principal);
      try {
        await this.client.call('cierreCaja', { token: session.token, body: built.body });
      } catch (error) {
        const kind = error instanceof ApiworkingError ? error.kind : 'UNKNOWN_RESULT';
        if (kind === 'UNKNOWN_RESULT' || kind === 'DUPLICATE' || kind === 'BAD_RESPONSE') {
          await log(AuditAction.ApiworkingCashCloseUnknown, { kind });
          return { status: 'UNKNOWN' as const, message: 'No se pudo confirmar el cierre: la caja pudo cerrarse. NO lo envíe de nuevo; compruebe el estado de la caja.' };
        }
        await log(AuditAction.ApiworkingCashCloseRejected, { kind });
        throw new UnprocessableEntityException({ message: error instanceof ApiworkingError ? clip(error.message) : 'Apiworking rechazó el cierre', code: 'REJECTED' });
      }
      const stillOpen = await this.openMovement(session.token, dto.idCaja).then((m) => m !== null).catch(() => true);
      if (!stillOpen) {
        await log(AuditAction.ApiworkingCashClosed, {});
        return { status: 'CLOSED' as const, message: 'Caja cerrada' };
      }
      await log(AuditAction.ApiworkingCashCloseUnknown, { kind: 'NOT_CONFIRMED' });
      return { status: 'UNCONFIRMED' as const, message: 'Apiworking respondió que cerró la caja, pero sigue apareciendo abierta. Compruebe su estado antes de reintentar.' };
    } finally {
      this.inFlight.delete(dto.idCaja);
    }
  }

  private async buildClose(principal: AuthPrincipal, draft: CashCloseDraftDto) {
    const session = this.clients.requireSession(principal);
    const cfg = this.config.apiworking;
    if (!cfg.authorizedCashRegisters.includes(draft.idCaja)) throw new BadRequestException('La caja no está autorizada para esta instalación');
    if (!session.personId) throw new UnprocessableEntityException({ message: 'Apiworking no informó id_persona en el inicio de sesión: no se puede cerrar la caja', code: 'NO_PERSON' });
    const caja = asRows(await this.client.call('caja', { token: session.token }), 'las cajas').find((r) => cajaId(r) === draft.idCaja);
    if (!caja) throw new BadRequestException('La caja no existe en Apiworking');
    const turn = draft.idTurno ?? DEFAULT_TURN;
    const body = { idPersona: session.personId, idTurno: turn, idCaja: draft.idCaja, cadenaDetalle: '', cadenaCierre: '', cadenaCierreDetalle: '', idCajaSel: '', ip: '', usuario: session.externalUserId };
    const hash = sha256(JSON.stringify({ tenant: cfg.expectedDatabase, op: 'close', body }));
    const isOpen = (await this.openMovement(session.token, draft.idCaja)) !== null;
    return { body, hash, turn, isOpen, cajaName: cajaName(caja) };
  }

  private async enforceCap() {
    const cfg = this.config.apiworking;
    const since = new Date(Date.now() - WINDOW_MS);
    const [sales, cash] = await Promise.all([
      this.db.apiworkingSale.count({ where: { tenant: cfg.expectedDatabase!, attemptedAt: { gte: since } } }),
      this.db.auditLog.count({ where: { action: { in: [AuditAction.ApiworkingCashOpenAttempt, AuditAction.ApiworkingCashCloseAttempt] }, createdAt: { gte: since } } }),
    ]);
    if (sales + cash >= cfg.maxRealOperations) {
      throw new ConflictException({ message: `Se alcanzó el tope de ${cfg.maxRealOperations} envíos reales en 24 horas (APIWORKING_MAX_REAL_OPERATIONS)`, code: 'REAL_OPERATIONS_LIMIT' });
    }
  }

  private async build(principal: AuthPrincipal, draft: CashOpenDraftDto) {
    const session = this.clients.requireSession(principal);
    const cfg = this.config.apiworking;
    if (!cfg.authorizedCashRegisters.includes(draft.idCaja)) throw new BadRequestException('La caja no está autorizada para esta instalación');
    if (!session.personId) throw new UnprocessableEntityException({ message: 'Apiworking no informó id_persona en el inicio de sesión: no se puede abrir la caja', code: 'NO_PERSON' });
    const cajas = asRows(await this.client.call('caja', { token: session.token }), 'las cajas');
    const caja = cajas.find((r) => cajaId(r) === draft.idCaja);
    if (!caja) throw new BadRequestException('La caja no existe en Apiworking');
    const turn = draft.idTurno ?? DEFAULT_TURN;
    const body = { idPersona: session.personId, idUsuario: session.externalUserId, idTurno: turn, idCaja: draft.idCaja, cadenaDetalle: `${SOLES}^${amountText(draft.openingCents)}` };
    const hash = sha256(JSON.stringify({ tenant: cfg.expectedDatabase, body }));
    const alreadyOpen = (await this.openMovement(session.token, draft.idCaja)) !== null;
    return { body, hash, turn, alreadyOpen, cajaName: cajaName(caja) };
  }

  private async openMovement(token: string, idCaja: string): Promise<string | null> {
    const data = await this.client.call('cajaApertura', { token, query: { idCaja } }).catch((e: unknown) => {
      if (isNoData(e)) return [];
      throw e;
    });
    const row = asRows(data, 'la apertura de caja')[0];
    return (row ? optText(row, 'id_movimiento_caja') : '') || null;
  }

  /** Los turnos son informativos: su forma no está confirmada, así que un formato distinto no bloquea la apertura. */
  private async turns(token: string): Promise<{ id: string; name: string }[]> {
    try {
      return asRows(await this.client.call('turnos', { token }), 'los turnos').flatMap((r) => {
        const id = optText(r, 'idTurno') || optText(r, 'id_turno');
        return id ? [{ id, name: optText(r, 'turno') || optText(r, 'nombre') || `Turno ${id}` }] : [];
      });
    } catch {
      return [];
    }
  }
}
