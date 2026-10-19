import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ACCOUNT_KIND_LABELS, DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from './cashbox-labels.js';
import type { SaveAccountDto, SaveCategoryDto } from './cashbox.dto.js';

const ignoreUnique = (e: unknown) => {
  if (!isUniqueViolation(e)) throw e;
};

export function cashScope(actor: AuthPrincipal): { clinicId: string; branchId: string | null } {
  const ctx = actor.context;
  if (!ctx || ctx.clinicId === null) throw new ForbiddenException('La caja chica solo es accesible dentro del contexto de una clínica');
  return { clinicId: ctx.clinicId, branchId: ctx.branchId };
}

/** Cuentas o medios de pago y tipos de operación. Se crean los valores habituales la primera vez; después son de la clínica. */
@Injectable()
export class CashboxConfigService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  async ensureDefaults(clinicId: string): Promise<void> {
    if ((await this.db.cashAccount.count({ where: { clinicId } })) === 0) {
      // Uno a uno: el orden de creación es el orden en que se muestran.
      for (const a of DEFAULT_ACCOUNTS) await this.db.cashAccount.create({ data: { clinicId, ...a } }).catch(ignoreUnique);
    }
    if ((await this.db.cashCategory.count({ where: { clinicId } })) === 0) {
      for (const c of DEFAULT_CATEGORIES) await this.db.cashCategory.create({ data: { clinicId, ...c } }).catch(ignoreUnique);
    }
  }

  async get(actor: AuthPrincipal) {
    const { clinicId, branchId } = cashScope(actor);
    await this.ensureDefaults(clinicId);
    const [accounts, categories, creators] = await Promise.all([
      this.db.cashAccount.findMany({ where: { clinicId }, orderBy: [{ active: 'desc' }, { createdAt: 'asc' }] }),
      this.db.cashCategory.findMany({ where: { clinicId }, orderBy: [{ active: 'desc' }, { flow: 'asc' }, { createdAt: 'asc' }] }),
      this.db.cashMovement.findMany({ where: { clinicId, ...(branchId ? { register: { branchId } } : {}) }, distinct: ['createdById'], select: { createdById: true } }),
    ]);
    const users = await this.db.user.findMany({ where: { id: { in: creators.map((c) => c.createdById) } }, select: { id: true, firstName: true, lastName: true } });
    return {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, kindLabel: ACCOUNT_KIND_LABELS[a.kind], allowNegative: a.allowNegative, active: a.active })),
      categories: categories.map((c) => ({ id: c.id, flow: c.flow, name: c.name, active: c.active })),
      users: users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}` })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async createAccount(actor: AuthPrincipal, dto: SaveAccountDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    await this.ensureDefaults(clinicId);
    try {
      const row = await this.db.cashAccount.create({ data: { clinicId, name: dto.name, kind: dto.kind, allowNegative: dto.allowNegative ?? false } });
      await this.record(actor, clinicId, branchId, meta, 'account_created', row.id);
      return row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe una cuenta con ese nombre');
      throw e;
    }
  }

  async updateAccount(actor: AuthPrincipal, id: string, dto: SaveAccountDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    const cur = await this.db.cashAccount.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('Cuenta no encontrada');
    // El tipo no cambia si ya tiene movimientos: reinterpretaría el arqueo de cierres pasados.
    if (dto.kind !== cur.kind && (await this.db.cashMovement.count({ where: { accountId: id } })) > 0) {
      throw new ConflictException('No se puede cambiar el tipo de una cuenta que ya tiene movimientos');
    }
    try {
      await this.db.cashAccount.update({ where: { id }, data: { name: dto.name, kind: dto.kind, allowNegative: dto.allowNegative ?? cur.allowNegative, active: dto.active ?? cur.active } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe una cuenta con ese nombre');
      throw e;
    }
    await this.record(actor, clinicId, branchId, meta, 'account_updated', id);
  }

  async createCategory(actor: AuthPrincipal, dto: SaveCategoryDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    if (!dto.flow) throw new ConflictException('Indique si el tipo es de ingreso o de egreso');
    await this.ensureDefaults(clinicId);
    try {
      const row = await this.db.cashCategory.create({ data: { clinicId, flow: dto.flow, name: dto.name } });
      await this.record(actor, clinicId, branchId, meta, 'category_created', row.id);
      return row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un tipo de operación con ese nombre');
      throw e;
    }
  }

  async updateCategory(actor: AuthPrincipal, id: string, dto: SaveCategoryDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    const cur = await this.db.cashCategory.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('Tipo de operación no encontrado');
    try {
      await this.db.cashCategory.update({ where: { id }, data: { name: dto.name, active: dto.active ?? cur.active } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un tipo de operación con ese nombre');
      throw e;
    }
    await this.record(actor, clinicId, branchId, meta, 'category_updated', id);
  }

  private record(actor: AuthPrincipal, clinicId: string, branchId: string | null, meta: RequestMeta, change: string, entityId: string) {
    return this.audit.record({ action: AuditAction.CashConfigChanged, entity: 'CashConfig', entityId, userId: actor.user.id, clinicId, branchId, meta, summary: { change } });
  }
}
