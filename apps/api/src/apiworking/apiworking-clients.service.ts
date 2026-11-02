import { ConflictException, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { AppConfig } from '../config/app-config.js';
import { ApiworkingClient, asRows, optText, reqId } from './apiworking.client.js';
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
    active: optText(r, 'estado').toUpperCase() === 'A',
  };
}

/** Lectura de clientes ya creados en el tenant de Apiworking (solo lectura; no crea ni modifica clientes). */
@Injectable()
export class ApiworkingClientsService {
  private cache: { tenant: string; at: number; rows: ExternalCustomer[] } | null = null;

  constructor(
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

  async list(principal: AuthPrincipal, q: { search?: string; limit: number; offset: number }) {
    const all = await this.loadAll(principal);
    const term = q.search?.trim().toLowerCase();
    const filtered = term
      ? all.filter((c) => c.name.toLowerCase().includes(term) || c.docNumber.toLowerCase().includes(term) || c.phone.includes(term))
      : all;
    return { items: filtered.slice(q.offset, q.offset + q.limit), total: filtered.length };
  }

  async find(principal: AuthPrincipal, id: string): Promise<ExternalCustomer | null> {
    const cached = (await this.loadAll(principal)).find((c) => c.id === id);
    if (cached) return cached;
    // Pudo crearse hace instantes: se vuelve a consultar una vez antes de darlo por inexistente.
    return (await this.loadAll(principal, true)).find((c) => c.id === id) ?? null;
  }

  private async loadAll(principal: AuthPrincipal, force = false): Promise<ExternalCustomer[]> {
    // La sesión de Apiworking se exige SIEMPRE, también cuando la lista sale del caché.
    const session = this.requireSession(principal);
    const tenant = this.config.apiworking.expectedDatabase!;
    const now = Date.now();
    if (!force && this.cache && this.cache.tenant === tenant && now - this.cache.at < CACHE_MS) return this.cache.rows;
    const data = await this.client.call('clientes', {
      token: session.token,
      query: { bd: tenant, displayStart: 1, displayLength: PAGE_SIZE },
    });
    const rows = asRows(data, 'la lista de clientes')
      .map(parseCustomer)
      .filter((c) => c.active)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    this.cache = { tenant, at: now, rows };
    return rows;
  }
}
