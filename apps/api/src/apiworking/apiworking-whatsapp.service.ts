import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import { clinicScope } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ApiworkingClient, ApiworkingError, asRecord, clip, optText } from './apiworking.client.js';
import { ApiworkingClientsService } from './apiworking-clients.service.js';
import { ApiworkingSalesService } from './apiworking-sales.service.js';
import { ApiworkingSessionStore } from './apiworking-session.store.js';

/** Texto permitido: sin caracteres de control salvo salto de línea, retorno y tabulación (guía de WhatsApp). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** El proveedor bloquea (403 HTML) los links que no son https de un dominio público. */
const INSECURE_LINK = /\bhttp:\/\/|\bhttps?:\/\/(localhost|127\.|10\.|192\.168\.)/i;

export class WhatsappSendDto {
  /** Celular del destinatario (9 dígitos peruanos o con código de país). */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @Matches(/^\+?[\d\s()-]{8,20}$/, { message: 'Celular inválido' }) phone!: string;
  @IsString() @MinLength(1) @MaxLength(1000) text!: string;
  /** De qué se trata el mensaje (para la auditoría). */
  @IsOptional() @IsIn(['sale', 'appointment', 'other']) context?: 'sale' | 'appointment' | 'other';
  @IsOptional() @IsUUID() refId?: string;
}

export class WhatsappDraftQuery {
  @IsOptional() @IsUUID() saleId?: string;
  @IsOptional() @IsUUID() appointmentId?: string;
}

/** Celular en el formato que exige Wasapaso: «+» y código de país (+51 para un celular peruano de 9 dígitos). */
export function toRecipient(phone: string): string | null {
  const d = phone.replace(/\D/g, '');
  if (/^9\d{8}$/.test(d)) return `+51${d}`;
  if (d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

/** Etiqueta del teléfono: el dominio del idSistema con los puntos (y demás) cambiados por «_». La misma en sesión, estado y envío. */
export function phoneLabelOf(systemId: string): string {
  return new URL(systemId).hostname.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Id del mensaje en la respuesta de Wasapaso: puede venir como message_id, messageId o id (también dentro de data). */
export function readMessageId(r: unknown): string | null {
  const pick = (o: unknown): string | null => {
    if (typeof o !== 'object' || o === null) return null;
    const x = o as Record<string, unknown>;
    for (const k of ['message_id', 'messageId', 'id']) if ((typeof x[k] === 'string' && x[k]) || typeof x[k] === 'number') return String(x[k]);
    return null;
  };
  const top = pick(r);
  if (top) return top;
  const data = typeof r === 'object' && r !== null ? ((r as Record<string, unknown>)['data'] ?? (r as Record<string, unknown>)['Data']) : null;
  return pick(data);
}

const STATUS_LABEL: Record<string, string> = { connected: 'Conectado', qr_pending: 'Esperando que escaneen el QR', disconnected: 'No vinculado', banned: 'Número bloqueado por WhatsApp' };

/**
 * WhatsApp por el centralizador de Apiworking (Wasapaso), con el número de la clínica vinculado por QR. Reglas de la guía: la
 * etiqueta es el dominio del idSistema; antes de enviar se consulta el estado; el destinatario va con «+» y código de país; solo
 * texto (los documentos van como links https); un envío NO se reintenta (un 5xx o tiempo agotado = no confirmado); un 401 cierra la
 * sesión externa; en la auditoría van el número, el id del mensaje y el largo, nunca el texto.
 */
@Injectable()
export class ApiworkingWhatsappService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly config: AppConfig,
    private readonly client: ApiworkingClient,
    private readonly clients: ApiworkingClientsService,
    private readonly sales: ApiworkingSalesService,
    private readonly store: ApiworkingSessionStore,
    private readonly audit: AuditService,
  ) {}

  private label(): string {
    const id = this.config.apiworking.systemId;
    if (!id) throw new ServiceUnavailableException({ message: 'Falta el idSistema de Apiworking en esta instalación', code: 'NOT_CONFIGURED' });
    return phoneLabelOf(id);
  }

  /** Un 401 de Apiworking: el token venció. Se cierra la sesión externa y se pide volver a ingresar. */
  private async guard<T>(principal: AuthPrincipal, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiworkingError && error.kind === 'AUTH') {
        this.store.delete(principal.sessionId);
        throw new ConflictException({ message: 'Su sesión de Apiworking venció: vuelva a iniciar sesión', code: 'APIWORKING_SESSION_REQUIRED' });
      }
      if (error instanceof ApiworkingError && error.kind === 'DISABLED') throw new ServiceUnavailableException({ message: error.message, code: 'WHATSAPP_DISABLED' });
      throw error;
    }
  }

  private present(data: unknown, phoneLabel: string) {
    const r = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const status = optText(r, 'status') || 'disconnected';
    return { phoneLabel, status, statusLabel: STATUS_LABEL[status] ?? status, phoneNumber: optText(r, 'phone_number') || null, qr: optText(r, 'qr') || null };
  }

  async status(principal: AuthPrincipal) {
    const session = this.clients.requireSession(principal);
    const phoneLabel = this.label();
    const data = await this.guard(principal, () => this.client.call('waStatus', { token: session.token, query: { phone_label: phoneLabel } }).catch((e: unknown) => {
      // «La sesion no existe» = no vinculado.
      if (e instanceof ApiworkingError && e.kind === 'REJECTED') return { status: 'disconnected' };
      throw e;
    }));
    const out = this.present(data, phoneLabel);
    return { ...out, qr: null };
  }

  /** Crea o reutiliza la sesión y devuelve el QR (texto del protocolo de WhatsApp; el panel lo dibuja). Solo administración. */
  async link(principal: AuthPrincipal, meta: RequestMeta) {
    const session = this.clients.requireSession(principal);
    const phoneLabel = this.label();
    const data = await this.guard(principal, () => this.client.call('waSession', { token: session.token, body: { phone_label: phoneLabel } }));
    const out = this.present(data, phoneLabel);
    const { clinicId, branchId } = clinicScope(principal);
    await this.audit.recordSafely({ action: 'WHATSAPP_LINK_REQUESTED', entity: 'Whatsapp', entityId: phoneLabel, userId: principal.user.id, clinicId, branchId, meta, summary: { status: out.status } });
    return out;
  }

  async send(principal: AuthPrincipal, dto: WhatsappSendDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(principal);
    const recipient = toRecipient(dto.phone);
    if (!recipient) throw new BadRequestException('Celular inválido: use 9 dígitos o el número con código de país');
    const text = dto.text.trim();
    if (!text || CONTROL.test(text)) throw new BadRequestException('El mensaje tiene caracteres no permitidos');
    if (INSECURE_LINK.test(text)) throw new BadRequestException('Los links del mensaje deben ser https de un dominio público');
    const session = this.clients.requireSession(principal);
    const phoneLabel = this.label();

    // Antes de enviar: el teléfono de la clínica debe estar conectado.
    const st = await this.status(principal);
    if (st.status === 'banned') throw new ConflictException({ message: 'WhatsApp bloqueó el número de la clínica: vincule otro número', code: 'WHATSAPP_BANNED' });
    if (st.status !== 'connected') throw new ConflictException({ message: 'WhatsApp no está vinculado: pida al administrador que vincule el teléfono (menú WhatsApp)', code: 'WHATSAPP_NOT_LINKED' });

    const summary = { recipient, length: text.length, context: dto.context ?? 'other', refId: dto.refId ?? null };
    const log = (action: string, extra: Record<string, unknown>) =>
      this.audit.recordSafely({ action, entity: 'Whatsapp', entityId: phoneLabel, userId: principal.user.id, clinicId, branchId, meta, summary: { ...summary, ...extra } });
    let res: unknown;
    try {
      res = await this.guard(principal, () => this.client.call('waSend', { token: session.token, body: { phone_label: phoneLabel, recipient, type: 'text', content: { text } } }));
    } catch (error) {
      if (error instanceof ApiworkingError && (error.kind === 'UNKNOWN_RESULT' || error.kind === 'BAD_RESPONSE')) {
        await log('WHATSAPP_UNCONFIRMED', { kind: error.kind });
        return { status: 'UNCONFIRMED' as const, message: 'No se pudo confirmar el envío: el mensaje pudo salir. Revise el chat antes de reenviar.' };
      }
      if (error instanceof ApiworkingError) {
        await log('WHATSAPP_REJECTED', { kind: error.kind });
        throw new UnprocessableEntityException({ message: clip(error.message) || 'WhatsApp rechazó el envío', code: 'WHATSAPP_REJECTED' });
      }
      throw error;
    }
    const body = typeof res === 'object' && res !== null ? (res as Record<string, unknown>) : {};
    if (body['success'] === false) {
      let reason = '';
      try { reason = clip(asRecord(body['error'], 'el error').message); } catch { /* sin detalle */ }
      await log('WHATSAPP_REJECTED', { kind: 'PROVIDER' });
      throw new UnprocessableEntityException({ message: reason || 'WhatsApp rechazó el envío', code: 'WHATSAPP_REJECTED' });
    }
    const messageId = readMessageId(res);
    await log('WHATSAPP_SENT', { messageId });
    return { status: 'SENT' as const, message: 'Mensaje enviado por WhatsApp', messageId };
  }

  /** Estado de un mensaje enviado (respuesta de Wasapaso tal cual, acotada a lo útil). */
  async message(principal: AuthPrincipal, messageId: string) {
    const session = this.clients.requireSession(principal);
    const data = await this.guard(principal, () => this.client.call('waMessage', { token: session.token, pathId: messageId }));
    const r = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const inner = (typeof r['data'] === 'object' && r['data'] !== null ? r['data'] : r) as Record<string, unknown>;
    return { messageId, status: optText(inner, 'status') || optText(inner, 'state') || null };
  }

  /**
   * Borrador del mensaje: destinatario (celular del paciente o del cliente) y texto listo para editar.
   * Venta: comprobante con el link público del PDF oficial de Apiworking. Cita: confirmación con fecha, hora, odontólogo y sede.
   */
  async draft(principal: AuthPrincipal, q: WhatsappDraftQuery) {
    const { clinicId } = clinicScope(principal);
    const clinic = await this.db.clinic.findUnique({ where: { id: clinicId }, select: { name: true, brandDisplayName: true } });
    const clinicName = clinic?.brandDisplayName || clinic?.name || 'la clínica';
    const mobileOf = async (patientId: string | null) => {
      if (!patientId) return null;
      const c = await this.db.patientContact.findFirst({ where: { clinicId, patientId, type: 'MOBILE', status: 'ACTIVE' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }], select: { value: true } });
      return c?.value ?? null;
    };
    if (q.saleId) {
      const sale = await this.db.apiworkingSale.findFirst({ where: { id: q.saleId, clinicId } });
      if (!sale) throw new NotFoundException('Venta no encontrada');
      let phone = await mobileOf(sale.patientId);
      if (!phone) {
        const c = await this.clients.findLocal(principal, sale.externalCustomerId).catch(() => null);
        phone = c?.whatsapp || c?.phone || null;
      }
      let link: string | null = null;
      if (sale.docStatus === 'SENT' && sale.externalDocId) link = (await this.sales.officialUrl(principal, sale.id).catch(() => null))?.url ?? null;
      const first = sale.customerName.split(/\s+/)[0] ?? '';
      const total = `S/ ${(sale.totalCents / 100).toFixed(2)}`;
      const text = [
        `Hola ${first}, gracias por su visita a ${clinicName}.`,
        sale.externalNumber ? `Su comprobante ${sale.externalNumber} por ${total}${link ? ':' : '.'}` : `Su pago por ${total} quedó registrado.`,
        link ?? '',
      ].filter(Boolean).join('\n');
      return { phone, text, context: 'sale' as const, refId: sale.id, hasLink: Boolean(link) };
    }
    if (q.appointmentId) {
      const a = await this.db.appointment.findFirst({
        where: { id: q.appointmentId, clinicId },
        include: { patient: { select: { firstName: true } }, dentist: { select: { firstName: true, lastName: true } }, service: { select: { name: true } }, branch: { select: { name: true, address: true } } },
      });
      if (!a) throw new NotFoundException('Cita no encontrada');
      const day = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long' }).format(a.startsAt);
      const time = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(a.startsAt);
      const text = [
        `Hola ${a.patient.firstName}, le recordamos su cita en ${clinicName}:`,
        `${day} a las ${time}, ${a.service.name} con ${a.dentist.firstName} ${a.dentist.lastName}.`,
        `Sede: ${a.branch.name}${a.branch.address ? ` (${a.branch.address})` : ''}.`,
        'Si no puede asistir, por favor avísenos respondiendo este mensaje.',
      ].join('\n');
      return { phone: await mobileOf(a.patientId), text, context: 'appointment' as const, refId: a.id, hasLink: false };
    }
    throw new BadRequestException('Indique la venta o la cita');
  }
}
