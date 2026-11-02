import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { clinicScope } from '../patients/patient-access.js';
import { AppConfig } from '../config/app-config.js';
import { ApiworkingClient, ApiworkingError, asRows, clip, optText, reqId, reqIdAny } from './apiworking.client.js';
import { enforceRealOperationsCap } from './real-operations.js';
import { ApiworkingSessionStore, type ExternalSession } from './apiworking-session.store.js';

export interface ExternalCustomer {
  id: string;
  personId: string;
  name: string;
  email: string;
  docType: string;
  docNumber: string;
  phone: string;
  whatsapp: string;
  personType: string;
  active: boolean;
}

const DOC_TYPES: Record<string, { label: string; pattern: RegExp }> = {
  '1': { label: 'DNI', pattern: /^\d{8}$/ },
  '6': { label: 'RUC', pattern: /^(10|15|17|20)\d{9}$/ },
  '4': { label: 'Carné de extranjería', pattern: /^[A-Za-z0-9]{6,12}$/ },
  '7': { label: 'Pasaporte', pattern: /^[A-Za-z0-9]{6,12}$/ },
  '0': { label: 'No domiciliado', pattern: /^[A-Za-z0-9]{1,15}$/ },
};
/** Etiqueta de tipoDoc de Apiworking (sin puntos) → código. */
const DOC_LABEL_TO_CODE: Record<string, string> = { DNI: '1', RUC: '6', CE: '4', CARNET: '4', PASAPORTE: '7' };
const personTypeOf = (docType: string) => (docType === '6' ? 'J' : 'N');
/** Fila del espejo local con la forma de un cliente de Apiworking. */
const fromMirror = (m: { externalCustomerId: string; name: string; docType: string; docNumber: string }): ExternalCustomer => ({
  id: m.externalCustomerId,
  personId: '',
  name: m.name,
  email: '',
  docType: DOC_TYPES[m.docType]?.label ?? m.docType,
  docNumber: m.docNumber,
  phone: '',
  whatsapp: '',
  personType: personTypeOf(m.docType),
  active: true,
});
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** Apiworking responde esto cuando el tenant aún no tiene clientes: es una lista vacía, no un fallo. */
const isEmptyList = (e: unknown) => e instanceof ApiworkingError && e.kind === 'REJECTED' && /no se pudo listar|no se encontr/i.test(e.message);

const CACHE_MS = 60_000;
const PAGE_SIZE = 1000;

export function parseCustomer(r: Record<string, unknown>): ExternalCustomer {
  return {
    id: reqId(r, 'id_cliente', 'un cliente'),
    personId: optText(r, 'id_persona'),
    name: optText(r, 'nombrecompleto'),
    email: optText(r, 'email'),
    docType: optText(r, 'tipoDoc'),
    docNumber: optText(r, 'numerodocumento'),
    phone: optText(r, 'telefono'),
    whatsapp: optText(r, 'whatsapp'),
    personType: optText(r, 'tipo_persona'),
    // Inactivo solo si Apiworking lo dice explícitamente: un estado ausente o con otro formato no oculta al cliente.
    active: !['I', 'INACTIVO', '0'].includes(optText(r, 'estado').toUpperCase()),
  };
}

/** Clientes del tenant de Apiworking: lectura y alta por documento (`ClienteDoc`, escritura real con vista previa, aprobación y tope). */
@Injectable()
export class ApiworkingClientsService {
  private readonly logger = new Logger('Apiworking');
  private cache: { tenant: string; at: number; rows: ExternalCustomer[] } | null = null;

  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly client: ApiworkingClient,
    private readonly store: ApiworkingSessionStore,
    private readonly config: AppConfig,
  ) {}

  /** Sesión de Apiworking de quien opera: sin ella (p. ej. tras reiniciar la API) hay que volver a entrar. */
  requireSession(principal: AuthPrincipal): ExternalSession {
    const session = this.store.get(principal.sessionId);
    if (!session) {
      throw new ConflictException({
        message: 'Vuelva a iniciar sesión con su cuenta de Apiworking para operar con Apiworking',
        code: 'APIWORKING_SESSION_REQUIRED',
      });
    }
    return session;
  }

  async list(principal: AuthPrincipal, q: { search?: string; limit: number; offset: number; local?: string }) {
    // Contingencia: solo el espejo local, sin consultar a Apiworking ni exigir su sesión.
    const { rows: all, offline } = q.local ? { rows: await this.mirrorRows(principal), offline: true } : await this.loadAll(principal);
    const term = q.search?.trim().toLowerCase();
    const filtered = term
      ? all.filter((c) => c.name.toLowerCase().includes(term) || c.docNumber.toLowerCase().includes(term) || c.phone.includes(term))
      : all;
    return { items: filtered.slice(q.offset, q.offset + q.limit), total: filtered.length, offline };
  }

  async find(principal: AuthPrincipal, id: string): Promise<ExternalCustomer | null> {
    const cached = (await this.loadAll(principal)).rows.find((c) => c.id === id);
    // Pudo crearse hace instantes: se vuelve a consultar una vez antes de darlo por inexistente.
    const found = cached ?? (await this.loadAll(principal, true)).rows.find((c) => c.id === id) ?? null;
    if (found) await this.remember(principal, found);
    return found;
  }

  /** Cliente del espejo local (sin Apiworking): lo usa la contingencia. */
  async findLocal(principal: AuthPrincipal, id: string): Promise<ExternalCustomer | null> {
    return (await this.mirrorRows(principal)).find((c) => c.id === id) ?? null;
  }

  /** Cliente por número de documento: primero el espejo y, si hay sesión y Apiworking responde, su lista. */
  async findByDocument(principal: AuthPrincipal, docNumber: string): Promise<ExternalCustomer | null> {
    const wanted = docNumber.trim().toUpperCase();
    const local = (await this.mirrorRows(principal)).find((c) => c.docNumber.toUpperCase() === wanted);
    if (local) return local;
    try {
      return (await this.loadAll(principal)).rows.find((c) => c.docNumber.toUpperCase() === wanted) ?? null;
    } catch {
      return null;
    }
  }

  private async mirrorRows(principal: AuthPrincipal): Promise<ExternalCustomer[]> {
    const rows = await this.db.apiworkingCustomer.findMany({ where: { tenant: this.config.apiworking.expectedDatabase!, clinicId: clinicScope(principal).clinicId } });
    return rows.map(fromMirror).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  /** Todo cliente que se usa en una venta queda en el espejo: así la contingencia lo encuentra aunque Apiworking no responda. */
  private async remember(principal: AuthPrincipal, c: ExternalCustomer): Promise<void> {
    const tenant = this.config.apiworking.expectedDatabase!;
    const docType = Object.entries(DOC_LABEL_TO_CODE).find(([k]) => c.docType.toUpperCase().replace(/[.\s]/g, '').startsWith(k))?.[1] ?? '0';
    try {
      await this.db.apiworkingCustomer.upsert({
        where: { tenant_externalCustomerId: { tenant, externalCustomerId: c.id } },
        create: { clinicId: clinicScope(principal).clinicId, tenant, externalCustomerId: c.id, docType, docNumber: c.docNumber.slice(0, 20), name: c.name.slice(0, 200), createdById: principal.user.id },
        update: {},
      });
    } catch {
      // Un documento repetido con otro id no debe impedir la venta: el espejo es solo un respaldo.
    }
  }

  /** Clientes de Apiworking + el espejo local (los creados aquí). Si Apiworking no responde, se sirve solo el espejo (`offline`). */
  private async loadAll(principal: AuthPrincipal, force = false): Promise<{ rows: ExternalCustomer[]; offline: boolean }> {
    // La sesión de Apiworking se exige SIEMPRE, también cuando la lista sale del caché.
    this.requireSession(principal);
    let remote: ExternalCustomer[] = [];
    let offline = false;
    try {
      remote = await this.loadRemote(principal, force);
    } catch (error) {
      if (!(error instanceof ApiworkingError) || error.kind === 'AUTH') throw error;
      offline = true;
      this.logger.warn(`clientes: Apiworking no respondió (${error.kind}); se usa el espejo local`);
    }
    const seen = new Set(remote.map((c) => c.id));
    const local = (await this.db.apiworkingCustomer.findMany({ where: { tenant: this.config.apiworking.expectedDatabase!, clinicId: clinicScope(principal).clinicId } }))
      .filter((c) => !seen.has(c.externalCustomerId))
      .map(fromMirror);
    const rows = [...remote, ...local].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return { rows, offline };
  }

  private async loadRemote(principal: AuthPrincipal, force: boolean): Promise<ExternalCustomer[]> {
    const session = this.requireSession(principal);
    const tenant = this.config.apiworking.expectedDatabase!;
    const now = Date.now();
    if (!force && this.cache && this.cache.tenant === tenant && now - this.cache.at < CACHE_MS) return this.cache.rows;
    const fetchPage = (displayStart: number) =>
      this.client
        .call('clientes', { token: session.token, query: { bd: tenant, displayStart, displayLength: PAGE_SIZE } })
        .then((d) => asRows(d, 'la lista de clientes'))
        .catch((e: unknown) => {
          if (isEmptyList(e)) return [];
          throw e;
        });
    let raw = await fetchPage(1);
    // Si el desplazamiento es 0-based, displayStart=1 se salta el primer cliente: con una lista vacía se prueba también 0.
    if (raw.length === 0) raw = await fetchPage(0);
    // Diagnóstico sin datos personales: cantidades y nombres de campo.
    this.logger.log(`clientes: ${raw.length} filas recibidas; campos: ${Object.keys(raw[0] ?? {}).slice(0, 20).join(', ') || 'ninguno'}`);
    const rows = raw
      .map(parseCustomer)
      .filter((c) => c.active)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    this.cache = { tenant, at: now, rows };
    return rows;
  }

  // --- Alta por documento: POST /api/Cliente/ClienteDoc?tipoDoc=…&nroDoc=… (sin cuerpo) ---

  private normalize(draft: { docType: string; docNumber: string }) {
    const def = DOC_TYPES[draft.docType];
    const docNumber = draft.docNumber.trim().toUpperCase();
    if (!def || !def.pattern.test(docNumber)) throw new BadRequestException(`El número no es válido para ${def?.label ?? 'ese tipo de documento'}`);
    return { docType: draft.docType, docNumber, label: def.label };
  }

  private async existing(principal: AuthPrincipal, docNumber: string): Promise<ExternalCustomer | null> {
    return (await this.loadAll(principal, true)).rows.find((c) => c.docNumber.toUpperCase() === docNumber) ?? null;
  }

  async previewCreate(principal: AuthPrincipal, draft: { docType: string; docNumber: string }) {
    this.requireSession(principal);
    const n = this.normalize(draft);
    const exists = await this.existing(principal, n.docNumber);
    const hash = sha256(JSON.stringify({ tenant: this.config.apiworking.expectedDatabase, op: 'cliente', tipoDoc: n.docType, nroDoc: n.docNumber }));
    return { hash, docType: n.docType, docTypeLabel: n.label, docNumber: n.docNumber, exists: exists ? { id: exists.id, name: exists.name } : null, write: this.config.apiworking.write };
  }

  async create(principal: AuthPrincipal, dto: { docType: string; docNumber: string; approvedHash: string; name?: string }, meta: RequestMeta) {
    const cfg = this.config.apiworking;
    if (!cfg.write) throw new ServiceUnavailableException({ message: 'Las escrituras reales de Apiworking están desactivadas en esta instalación', code: 'WRITE_DISABLED' });
    const session = this.requireSession(principal);
    const n = this.normalize(dto);
    const p = await this.previewCreate(principal, dto);
    if (p.hash !== dto.approvedHash) throw new ConflictException({ message: 'Los datos cambiaron después de la vista previa: revise y apruebe de nuevo', code: 'PREVIEW_CHANGED' });
    if (p.exists) throw new ConflictException({ message: 'Ese cliente ya existe en Apiworking', code: 'ALREADY_EXISTS', customerId: p.exists.id });
    await enforceRealOperationsCap(this.db, this.config);

    // Nunca se guarda el número de documento (queda en la URL de Apiworking): solo el tipo y el id resultante.
    const log = (action: string, extra: Record<string, unknown>) =>
      this.audit.recordSafely({ action, entity: 'ApiworkingCustomer', userId: principal.user.id, clinicId: principal.context?.clinicId ?? null, meta, summary: { docType: n.docType, ...extra } });
    await this.audit.record({ action: AuditAction.ApiworkingCustomerAttempt, entity: 'ApiworkingCustomer', userId: principal.user.id, clinicId: principal.context?.clinicId ?? null, meta, summary: { docType: n.docType } });

    let id: string;
    try {
      const data = await this.client.call('clienteDoc', { token: session.token, query: { tipoDoc: n.docType, nroDoc: n.docNumber } });
      id = reqIdAny(asRows(data, 'el alta del cliente')[0] ?? {}, ['id', 'idCliente', 'id_cliente'], 'el alta del cliente');
    } catch (error) {
      const kind = error instanceof ApiworkingError ? error.kind : 'UNKNOWN_RESULT';
      if (kind === 'UNKNOWN_RESULT' || kind === 'DUPLICATE' || kind === 'BAD_RESPONSE') {
        await log(AuditAction.ApiworkingCustomerUnknown, { kind });
        this.cache = null;
        return { status: 'UNKNOWN' as const, message: 'No se pudo confirmar el alta: el cliente pudo crearse. Busque al cliente antes de intentarlo de nuevo.' };
      }
      await log(AuditAction.ApiworkingCustomerRejected, { kind });
      throw new UnprocessableEntityException({ message: error instanceof ApiworkingError ? clip(error.message) : 'Apiworking rechazó el alta', code: 'REJECTED' });
    }
    this.cache = null;
    await log(AuditAction.ApiworkingCustomerCreated, { customerId: id });
    // Espejo local: así el cliente se encuentra aunque Apiworking no lo liste o no responda.
    const tenant = cfg.expectedDatabase!;
    const name = (dto.name?.trim() || `${n.label} ${n.docNumber}`).slice(0, 200);
    const clinicId = clinicScope(principal).clinicId;
    const mirror = await this.db.apiworkingCustomer.upsert({
      where: { tenant_externalCustomerId: { tenant, externalCustomerId: id } },
      create: { clinicId, tenant, externalCustomerId: id, docType: n.docType, docNumber: n.docNumber, name, createdById: principal.user.id },
      update: { docType: n.docType, docNumber: n.docNumber, ...(dto.name?.trim() ? { name } : {}) },
    });
    const found = fromMirror(mirror);
    return { status: 'CREATED' as const, id, customer: found };
  }
}
