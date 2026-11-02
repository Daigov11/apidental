import { randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { hashPassword } from '../common/utils/password.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ApiworkingClient, ApiworkingError, asRecord, optText, reqId } from './apiworking.client.js';
import { ApiworkingSessionStore } from './apiworking-session.store.js';

const PROVIDER = 'APIWORKING';
const INVALID_CREDENTIALS = 'Credenciales inválidas';

/** Datos que se leen del login (todos obligatorios salvo roles y sucursal, que solo informan). */
export interface ExternalLogin {
  token: string;
  userId: string;
  username: string;
  fullName: string;
  branchId: string | null;
  personId: string | null;
  roles: unknown;
  tenant: string;
}

export function parseLogin(data: unknown): ExternalLogin {
  const d = asRecord(data, 'el login');
  const token = d['token'];
  if (typeof token !== 'string' || token.length < 10) throw new ApiworkingError('BAD_RESPONSE', 'Apiworking: falta token en el login');
  const empresa = d['empresa'];
  const tenant = typeof empresa === 'object' && empresa !== null ? optText(empresa as Record<string, unknown>, 'base_datos') : '';
  return {
    token,
    userId: reqId(d, 'id_usuario', 'el login'),
    username: reqId(d, 'usuario', 'el login'),
    fullName: optText(d, 'nombrecompleto'),
    branchId: optText(d, 'id_sucursal') || null,
    personId: optText(d, 'id_persona') || null,
    roles: d['roles'] ?? null,
    tenant,
  };
}

/**
 * Inicio de sesión con la cuenta de Apiworking del tenant. Entrar NO da permisos: el usuario local nace sin roles y un
 * administrador local se los asigna. Los roles externos se guardan solo como información.
 */
@Injectable()
export class ApiworkingAuthService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly config: AppConfig,
    private readonly client: ApiworkingClient,
    private readonly store: ApiworkingSessionStore,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async login(usuario: string, password: string, meta: RequestMeta) {
    const cfg = this.config.apiworking;
    if (this.config.authMode !== 'apiworking' || !cfg.configured) throw new NotFoundException('El inicio de sesión con Apiworking no está habilitado');

    let login: ExternalLogin;
    try {
      const data = await this.client.call('login', { body: { usuario, password, idSistema: cfg.systemId } });
      login = parseLogin(data);
    } catch (error) {
      await this.failed(meta, error instanceof ApiworkingError ? error.kind : 'ERROR');
      if (error instanceof ApiworkingError && ['UNKNOWN_RESULT', 'RATE_LIMIT', 'DISABLED', 'BAD_RESPONSE'].includes(error.kind)) {
        throw new ServiceUnavailableException('No se pudo validar el acceso con Apiworking. Intente de nuevo en unos minutos');
      }
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // El tenant debe coincidir exactamente: si falta o es otro, se rechaza (una cuenta válida de otro tenant no entra).
    if (login.tenant !== cfg.expectedDatabase) {
      await this.failed(meta, 'tenant_mismatch');
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const user = await this.findOrCreateUser(login, meta);
    if (user.status !== 'ACTIVE') {
      await this.failed(meta, 'user_disabled');
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const started = await this.auth.startSession(user, meta, { via: 'apiworking' });
    // El JWT externo se queda en memoria del servidor, atado a la sesión local.
    this.store.set(started.sessionId, { userId: user.id, token: login.token, branchId: login.branchId, username: login.username, externalUserId: login.userId, personId: login.personId });
    return {
      refreshToken: started.refreshToken,
      body: { ...started.body, pendingAccess: started.body.contexts.length === 0 },
    };
  }

  private async findOrCreateUser(login: ExternalLogin, meta: RequestMeta) {
    const where = { provider_tenant_externalUserId: { provider: PROVIDER, tenant: login.tenant, externalUserId: login.userId } };
    const info = { externalUsername: login.username, externalBranchId: login.branchId, externalRoles: toJson(login.roles), lastLoginAt: new Date() };

    const existing = await this.db.externalIdentity.findUnique({ where, include: { user: true } });
    if (existing) {
      await this.db.externalIdentity.update({ where: { id: existing.id }, data: info });
      return existing.user;
    }

    const [first, ...rest] = (login.fullName || login.username).split(/\s+/).filter(Boolean);
    // Sin contraseña local: se guarda el hash de un secreto aleatorio que nadie conoce (el acceso es por Apiworking).
    const unusable = await hashPassword(randomBytes(32).toString('base64'));
    try {
      const user = await this.db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: `aw-${login.userId}@apiworking.invalid`,
            passwordHash: unusable,
            firstName: (first ?? login.username).slice(0, 100),
            lastName: (rest.join(' ') || '-').slice(0, 100),
          },
        });
        await tx.externalIdentity.create({ data: { userId: created.id, provider: PROVIDER, tenant: login.tenant, externalUserId: login.userId, ...info } });
        await this.audit.record(
          { action: AuditAction.ApiworkingIdentityLinked, entity: 'User', entityId: created.id, userId: created.id, meta, summary: { provider: PROVIDER } },
          tx,
        );
        return created;
      });
      return user;
    } catch (error) {
      // Dos ingresos simultáneos de la misma cuenta: gana el primero y el segundo lo reutiliza.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.db.externalIdentity.findUnique({ where, include: { user: true } });
      if (!raced) throw error;
      return raced.user;
    }
  }

  private failed(meta: RequestMeta, reason: string) {
    return this.audit.recordSafely({ action: AuditAction.ApiworkingLoginFailed, entity: 'User', meta, summary: { reason } });
  }
}

/** Roles externos: solo informativos; se guarda una copia JSON acotada. */
function toJson(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === null || v === undefined) return undefined;
  const text = JSON.stringify(v);
  return text.length <= 2000 ? (JSON.parse(text) as Prisma.InputJsonValue) : undefined;
}
