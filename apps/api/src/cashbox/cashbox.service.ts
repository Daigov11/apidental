import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import { isUniqueViolation } from '../patients/patient-access.js';
import type { DbTx, PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { CashboxConfigService, cashScope } from './cashbox-config.service.js';
import { ACCOUNT_KIND_LABELS, FLOW_LABELS, KIND_LABELS, limaNextDay, limaStart, money } from './cashbox-labels.js';
import type { CloseSessionDto, CreateMovementDto, ListMovementsQuery, OpenSessionDto, VoidMovementDto } from './cashbox.dto.js';

const FUTURE_SLACK_MS = 5 * 60_000;

type MovementRow = NonNullable<Awaited<ReturnType<CashboxService['rawMovement']>>>;

/**
 * Caja chica por sede. El saldo de cada cuenta es la suma de sus movimientos vigentes (ingresos − egresos): no hay un saldo
 * guardado que pueda desincronizarse. La apertura y el arqueo de cierre generan ajustes automáticos para que el libro siempre
 * cuadre con el efectivo contado. Cada escritura incrementa `version` de la sesión abierta, lo que serializa los movimientos
 * concurrentes y hace confiable la validación de saldo. Los movimientos no se editan ni se borran: se anulan con motivo.
 * La auditoría guarda referencias, tipo y monto; nunca descripciones.
 */
@Injectable()
export class CashboxService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly config: CashboxConfigService,
  ) {}

  // ------------------------------------------------------------------ utilidades

  private async register(clinicId: string, branchId: string | null) {
    if (!branchId) throw new BadRequestException('Seleccione una sede: la caja chica es de cada sede');
    const branch = await this.db.branch.findFirst({ where: { id: branchId, clinicId }, select: { id: true, name: true } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    return { branch, register: await this.db.cashRegister.findUnique({ where: { branchId } }) };
  }

  private async ensureRegister(clinicId: string, branchId: string | null) {
    const { branch, register } = await this.register(clinicId, branchId);
    if (register) return { branch, register };
    try {
      return { branch, register: await this.db.cashRegister.create({ data: { clinicId, branchId: branch.id, name: `Caja ${branch.name}` } }) };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return { branch, register: await this.db.cashRegister.findUniqueOrThrow({ where: { branchId: branch.id } }) };
    }
  }

  /**
   * Bloquea la caja: la PRIMERA sentencia de la transacción incrementa la versión de la sesión abierta. Con REPEATABLE READ la
   * instantánea de lectura nace en la primera consulta, así que bloquear antes de leer garantiza que el saldo que se valida
   * incluye todo lo confirmado por quien tenía el bloqueo.
   */
  private async lockOpenSession(tx: DbTx, registerId: string) {
    const { count } = await tx.cashSession.updateMany({ where: { registerId, status: 'OPEN' }, data: { version: { increment: 1 } } });
    return count > 0;
  }

  /** Saldo vigente por cuenta (ingresos − egresos de todos los movimientos no anulados). */
  private async balances(db: PrismaDb | DbTx, registerId: string, upTo?: Date): Promise<Map<string, number>> {
    const rows = await db.cashMovement.groupBy({
      by: ['accountId', 'flow'],
      where: { registerId, status: 'ACTIVE', ...(upTo ? { occurredAt: { lt: upTo } } : {}) },
      _sum: { amountCents: true },
    });
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.accountId, (out.get(r.accountId) ?? 0) + (r.flow === 'INCOME' ? 1 : -1) * (r._sum.amountCents ?? 0));
    return out;
  }

  private async names(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((i): i is string => Boolean(i)))];
    const users = await this.db.user.findMany({ where: { id: { in: list } }, select: { id: true, firstName: true, lastName: true } });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  }

  rawMovement(clinicId: string, id: string) {
    return this.db.cashMovement.findFirst({ where: { id, clinicId }, include: { account: true, category: true } });
  }

  private present(m: MovementRow, names: Map<string, string>) {
    return {
      id: m.id,
      flow: m.flow,
      flowLabel: FLOW_LABELS[m.flow],
      kind: m.kind,
      kindLabel: KIND_LABELS[m.kind],
      description: m.description,
      operationNumber: m.operationNumber,
      amountCents: m.amountCents,
      amountText: money(m.amountCents),
      occurredAt: m.occurredAt.toISOString(),
      createdAt: m.createdAt.toISOString(),
      status: m.status,
      voidReason: m.voidReason,
      voidedAt: m.voidedAt?.toISOString() ?? null,
      voidedBy: m.voidedById ? (names.get(m.voidedById) ?? '—') : null,
      account: { id: m.account.id, name: m.account.name, kind: m.account.kind },
      category: m.category ? { id: m.category.id, name: m.category.name } : null,
      user: { id: m.createdById, name: names.get(m.createdById) ?? '—' },
    };
  }

  private audited(actor: AuthPrincipal, clinicId: string, branchId: string | null, meta: RequestMeta, action: string, entity: string, entityId: string, summary: Record<string, unknown>, tx?: DbTx) {
    return this.audit.record({ action, entity, entityId, userId: actor.user.id, clinicId, branchId, meta, summary }, tx);
  }

  // ------------------------------------------------------------------ resumen

  async summary(actor: AuthPrincipal) {
    const { clinicId, branchId } = cashScope(actor);
    await this.config.ensureDefaults(clinicId);
    const { branch, register } = await this.register(clinicId, branchId);
    const accounts = await this.db.cashAccount.findMany({ where: { clinicId }, orderBy: { createdAt: 'asc' } });
    const base = { branch: { id: branch.id, name: branch.name }, register: register ? { id: register.id, name: register.name } : null };
    if (!register) {
      return { ...base, session: null, lastClosedAt: null, accounts: accounts.filter((a) => a.active).map((a) => this.accountRow(a, null, 0, 0, 0)), totals: { openingCents: 0, incomeCents: 0, expenseCents: 0, balanceCents: 0 } };
    }
    const [session, bal, lastClosed] = await Promise.all([
      this.db.cashSession.findFirst({ where: { registerId: register.id, status: 'OPEN' }, include: { accounts: true } }),
      this.balances(this.db, register.id),
      this.db.cashSession.findFirst({ where: { registerId: register.id, status: 'CLOSED' }, orderBy: { closedAt: 'desc' }, select: { closedAt: true } }),
    ]);
    const flows = session
      ? await this.db.cashMovement.groupBy({ by: ['accountId', 'flow'], where: { sessionId: session.id, status: 'ACTIVE', kind: 'NORMAL' }, _sum: { amountCents: true } })
      : [];
    const sum = (accountId: string, flow: string) => flows.find((f) => f.accountId === accountId && f.flow === flow)?._sum.amountCents ?? 0;
    const rows = accounts
      .filter((a) => a.active || (bal.get(a.id) ?? 0) !== 0)
      .map((a) => this.accountRow(a, session ? (session.accounts.find((x) => x.accountId === a.id)?.openingCents ?? 0) : null, sum(a.id, 'INCOME'), sum(a.id, 'EXPENSE'), bal.get(a.id) ?? 0));
    const total = (k: 'incomeCents' | 'expenseCents' | 'balanceCents') => rows.reduce((s, r) => s + r[k], 0);
    const names = session ? await this.names([session.openedById]) : new Map<string, string>();
    return {
      ...base,
      session: session ? { id: session.id, openedAt: session.openedAt.toISOString(), openedBy: names.get(session.openedById) ?? '—', openNotes: session.openNotes } : null,
      lastClosedAt: lastClosed?.closedAt?.toISOString() ?? null,
      accounts: rows,
      totals: { openingCents: rows.reduce((s, r) => s + (r.openingCents ?? 0), 0), incomeCents: total('incomeCents'), expenseCents: total('expenseCents'), balanceCents: total('balanceCents') },
    };
  }

  private accountRow(a: { id: string; name: string; kind: keyof typeof ACCOUNT_KIND_LABELS; allowNegative: boolean; active: boolean }, openingCents: number | null, incomeCents: number, expenseCents: number, balanceCents: number) {
    return { id: a.id, name: a.name, kind: a.kind, kindLabel: ACCOUNT_KIND_LABELS[a.kind], active: a.active, allowNegative: a.allowNegative, openingCents, incomeCents, expenseCents, balanceCents };
  }

  // ------------------------------------------------------------------ apertura y cierre

  async open(actor: AuthPrincipal, dto: OpenSessionDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    await this.config.ensureDefaults(clinicId);
    const { register } = await this.ensureRegister(clinicId, branchId);
    const accounts = await this.db.cashAccount.findMany({ where: { clinicId, active: true } });
    const given = new Map<string, number>();
    for (const o of dto.openings ?? []) {
      if (!accounts.some((a) => a.id === o.accountId)) throw new BadRequestException('Una de las cuentas indicadas no existe o está inactiva');
      if (given.has(o.accountId)) throw new BadRequestException('Una cuenta aparece repetida en la apertura');
      given.set(o.accountId, o.amountCents);
    }
    const id = await withTxRetry(() =>
      this.db
        .$transaction(async (tx) => {
          const carry = await this.balances(tx, register.id);
          const hasPrevious = (await tx.cashSession.count({ where: { registerId: register.id } })) > 0;
          const lines = accounts.map((a) => {
            const amount = given.get(a.id) ?? carry.get(a.id) ?? 0;
            return { account: a, amount, diff: amount - (carry.get(a.id) ?? 0) };
          });
          if (hasPrevious && lines.some((l) => l.diff !== 0) && !dto.notes) {
            throw new UnprocessableEntityException('El saldo inicial difiere del saldo con que cerró la caja; explique la diferencia en las notas');
          }
          const openedAt = new Date();
          const session = await tx.cashSession.create({ data: { clinicId, registerId: register.id, openKey: register.id, openedAt, openedById: actor.user.id, openNotes: dto.notes ?? null } });
          for (const l of lines) {
            await tx.cashSessionAccount.create({ data: { sessionId: session.id, accountId: l.account.id, openingCents: l.amount } });
            if (l.diff !== 0) {
              await tx.cashMovement.create({
                data: {
                  clinicId, registerId: register.id, sessionId: session.id, accountId: l.account.id, flow: l.diff > 0 ? 'INCOME' : 'EXPENSE', kind: 'OPENING',
                  description: hasPrevious ? 'Ajuste de apertura' : 'Saldo inicial', amountCents: Math.abs(l.diff), occurredAt: openedAt, createdById: actor.user.id,
                },
              });
            }
          }
          await this.audited(actor, clinicId, branchId, meta, AuditAction.CashSessionOpened, 'CashSession', session.id, { openingTotalCents: lines.reduce((s, l) => s + l.amount, 0), adjusted: lines.some((l) => l.diff !== 0) }, tx);
          return session.id;
        })
        .catch((e: unknown) => {
          if (isUniqueViolation(e)) throw new ConflictException('La caja ya está abierta');
          throw e;
        }),
    );
    return { id };
  }

  async close(actor: AuthPrincipal, dto: CloseSessionDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    const { register } = await this.register(clinicId, branchId);
    if (!register) throw new ConflictException('La caja no está abierta');
    const accounts = await this.db.cashAccount.findMany({ where: { clinicId } });
    const counts = new Map<string, number>();
    for (const c of dto.counts) {
      if (!accounts.some((a) => a.id === c.accountId)) throw new BadRequestException('Una de las cuentas indicadas no existe');
      counts.set(c.accountId, c.countedCents);
    }
    const result = await withTxRetry(() =>
      this.db.$transaction(async (tx) => {
        if (!(await this.lockOpenSession(tx, register.id))) throw new ConflictException('La caja no está abierta');
        const session = await tx.cashSession.findFirstOrThrow({ where: { registerId: register.id, status: 'OPEN' } });
        const bal = await this.balances(tx, register.id);
        const now = new Date();
        const lines: { accountId: string; name: string; expected: number; counted: number | null; diff: number | null }[] = [];
        for (const a of accounts.filter((x) => x.active || (bal.get(x.id) ?? 0) !== 0 || x.kind === 'CASH')) {
          const expected = bal.get(a.id) ?? 0;
          const mustCount = a.kind === 'CASH' && a.active;
          const counted = counts.get(a.id) ?? null;
          if (mustCount && counted === null) throw new UnprocessableEntityException(`Cuente el efectivo de «${a.name}» para cerrar la caja`);
          lines.push({ accountId: a.id, name: a.name, expected, counted, diff: counted === null ? null : counted - expected });
        }
        if (lines.some((l) => l.diff) && !dto.notes) throw new UnprocessableEntityException('Hay diferencia entre el efectivo contado y el esperado; explíquela en las notas');
        for (const l of lines) {
          await tx.cashSessionAccount.upsert({
            where: { sessionId_accountId: { sessionId: session.id, accountId: l.accountId } },
            create: { sessionId: session.id, accountId: l.accountId, openingCents: 0, expectedCents: l.expected, countedCents: l.counted, differenceCents: l.diff },
            update: { expectedCents: l.expected, countedCents: l.counted, differenceCents: l.diff },
          });
          if (l.diff) {
            await tx.cashMovement.create({
              data: { clinicId, registerId: register.id, sessionId: session.id, accountId: l.accountId, flow: l.diff > 0 ? 'INCOME' : 'EXPENSE', kind: 'COUNT_ADJUSTMENT', description: 'Ajuste por arqueo de caja', amountCents: Math.abs(l.diff), occurredAt: now, createdById: actor.user.id },
            });
          }
        }
        await tx.cashSession.update({ where: { id: session.id }, data: { status: 'CLOSED', openKey: null, closedAt: now, closedById: actor.user.id, closeNotes: dto.notes ?? null } });
        await this.audited(actor, clinicId, branchId, meta, AuditAction.CashSessionClosed, 'CashSession', session.id, { differenceCents: lines.reduce((s, l) => s + (l.diff ?? 0), 0), adjusted: lines.some((l) => l.diff) }, tx);
        return { id: session.id, lines };
      }),
    );
    return { id: result.id, accounts: result.lines.map((l) => ({ accountId: l.accountId, name: l.name, expectedCents: l.expected, countedCents: l.counted, differenceCents: l.diff })) };
  }

  // ------------------------------------------------------------------ movimientos

  async create(actor: AuthPrincipal, dto: CreateMovementDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    const { register } = await this.register(clinicId, branchId);
    if (!register) throw new ConflictException('Abra la caja antes de registrar movimientos');
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException('La fecha del movimiento no es válida');
    if (occurredAt.getTime() > Date.now() + FUTURE_SLACK_MS) throw new UnprocessableEntityException('La fecha del movimiento no puede ser futura');

    // Reenvío del mismo formulario: se devuelve el movimiento ya registrado.
    const again = await this.db.cashMovement.findFirst({ where: { clinicId, requestKey: dto.requestKey } });
    if (again) return this.one(clinicId, again.id);

    const [account, category] = await Promise.all([
      this.db.cashAccount.findFirst({ where: { id: dto.accountId, clinicId } }),
      this.db.cashCategory.findFirst({ where: { id: dto.categoryId, clinicId } }),
    ]);
    if (!account || !account.active) throw new UnprocessableEntityException('Elija una cuenta o medio de pago activo');
    if (!category || !category.active || category.flow !== dto.flow) throw new UnprocessableEntityException('Elija un tipo de operación activo que corresponda a este movimiento');

    try {
      const id = await withTxRetry(() =>
        this.db.$transaction(async (tx) => {
          if (!(await this.lockOpenSession(tx, register.id))) throw new ConflictException('Abra la caja antes de registrar movimientos');
          const session = await tx.cashSession.findFirstOrThrow({ where: { registerId: register.id, status: 'OPEN' } });
          // Los formularios trabajan al minuto: se tolera hasta el minuto de la apertura.
          if (occurredAt.getTime() < Math.floor(session.openedAt.getTime() / 60_000) * 60_000) throw new UnprocessableEntityException('La fecha del movimiento es anterior a la apertura de la caja');
          if (dto.operationNumber) {
            const dup = await tx.cashMovement.findFirst({ where: { operationKey: `${account.id}|${dto.operationNumber.toUpperCase()}` }, select: { id: true } });
            if (dup) throw new ConflictException({ message: 'Ya se registró un movimiento con ese número de operación en esta cuenta', code: 'DUPLICATE_OPERATION' });
          }
          if (dto.flow === 'EXPENSE' && !account.allowNegative) {
            const balance = (await this.balances(tx, register.id)).get(account.id) ?? 0;
            if (dto.amountCents > balance) {
              throw new UnprocessableEntityException({ message: `Saldo insuficiente en «${account.name}»: disponible ${money(balance)}`, code: 'INSUFFICIENT_BALANCE' });
            }
          }
          const row = await tx.cashMovement.create({
            data: {
              clinicId, registerId: register.id, sessionId: session.id, accountId: account.id, categoryId: category.id, flow: dto.flow, description: dto.description,
              operationNumber: dto.operationNumber ?? null, amountCents: dto.amountCents, occurredAt, createdById: actor.user.id, requestKey: dto.requestKey,
              operationKey: dto.operationNumber ? `${account.id}|${dto.operationNumber.toUpperCase()}` : null,
            },
          });
          await this.audited(actor, clinicId, branchId, meta, AuditAction.CashMovementCreated, 'CashMovement', row.id, { flow: dto.flow, amountCents: dto.amountCents, accountId: account.id, categoryId: category.id }, tx);
          return row.id;
        }),
      );
      return this.one(clinicId, id);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const raced = await this.db.cashMovement.findFirst({ where: { clinicId, requestKey: dto.requestKey } });
        if (raced) return this.one(clinicId, raced.id);
        throw new ConflictException({ message: 'Ya se registró un movimiento con ese número de operación en esta cuenta', code: 'DUPLICATE_OPERATION' });
      }
      throw e;
    }
  }

  private async one(clinicId: string, id: string) {
    const row = await this.rawMovement(clinicId, id);
    if (!row) throw new NotFoundException('Movimiento no encontrado');
    return this.present(row, await this.names([row.createdById, row.voidedById]));
  }

  async void(actor: AuthPrincipal, id: string, dto: VoidMovementDto, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    const { register } = await this.register(clinicId, branchId);
    const cur = register ? await this.rawMovement(clinicId, id) : null;
    if (!register || !cur || cur.registerId !== register.id) throw new NotFoundException('Movimiento no encontrado');
    await withTxRetry(() =>
      this.db.$transaction(async (tx) => {
        const locked = await this.lockOpenSession(tx, register.id);
        const m = await tx.cashMovement.findUniqueOrThrow({ where: { id }, include: { account: true, session: true } });
        if (m.status === 'VOIDED') throw new ConflictException('El movimiento ya fue anulado');
        if (m.kind !== 'NORMAL') throw new UnprocessableEntityException('Los ajustes automáticos de apertura y arqueo no se anulan');
        if (m.session.status !== 'OPEN') throw new ConflictException('El movimiento pertenece a una caja ya cerrada y no se puede anular');
        if (!locked) throw new ConflictException('La caja está cerrada; el movimiento no se puede anular');
        if (m.flow === 'INCOME' && !m.account.allowNegative) {
          const balance = (await this.balances(tx, register.id)).get(m.accountId) ?? 0;
          if (balance - m.amountCents < 0) throw new ConflictException({ message: 'Anular este ingreso dejaría la cuenta con saldo negativo; anule antes los egresos posteriores', code: 'INSUFFICIENT_BALANCE' });
        }
        await tx.cashMovement.update({ where: { id }, data: { status: 'VOIDED', voidedAt: new Date(), voidedById: actor.user.id, voidReason: dto.reason, operationKey: null } });
        await this.audited(actor, clinicId, branchId, meta, AuditAction.CashMovementVoided, 'CashMovement', id, { flow: m.flow, amountCents: m.amountCents, reason: dto.reason }, tx);
      }),
    );
    return this.one(clinicId, id);
  }

  private where(clinicId: string, registerId: string, q: ListMovementsQuery) {
    return {
      clinicId,
      registerId,
      ...(q.includeVoided ? {} : { status: 'ACTIVE' as const }),
      ...(q.flow ? { flow: q.flow } : {}),
      ...(q.accountId ? { accountId: q.accountId } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.userId ? { createdById: q.userId } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: limaStart(q.from) } : {}), ...(q.to ? { lt: limaNextDay(q.to) } : {}) } } : {}),
    };
  }

  async list(actor: AuthPrincipal, q: ListMovementsQuery) {
    const { clinicId, branchId } = cashScope(actor);
    const { register } = await this.register(clinicId, branchId);
    if (!register) return { items: [], total: 0, incomeCents: 0, expenseCents: 0 };
    const where = this.where(clinicId, register.id, q);
    const [rows, total, sums] = await Promise.all([
      this.db.cashMovement.findMany({ where, include: { account: true, category: true }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: q.limit, skip: q.offset }),
      this.db.cashMovement.count({ where }),
      this.db.cashMovement.groupBy({ by: ['flow'], where: { ...where, status: 'ACTIVE', kind: 'NORMAL' }, _sum: { amountCents: true } }),
    ]);
    const names = await this.names(rows.flatMap((r) => [r.createdById, r.voidedById]));
    return {
      items: rows.map((r) => this.present(r, names)),
      total,
      incomeCents: sums.find((s) => s.flow === 'INCOME')?._sum.amountCents ?? 0,
      expenseCents: sums.find((s) => s.flow === 'EXPENSE')?._sum.amountCents ?? 0,
    };
  }

  // ------------------------------------------------------------------ datos del reporte

  async reportData(actor: AuthPrincipal, from: string, to: string) {
    const { clinicId, branchId } = cashScope(actor);
    const start = limaStart(from);
    const end = limaNextDay(to);
    if (end <= start) throw new BadRequestException('La fecha final no puede ser anterior a la inicial');
    if (end.getTime() - start.getTime() > 366 * 86_400_000) throw new BadRequestException('El rango del reporte no puede superar un año');
    const { branch, register } = await this.register(clinicId, branchId);
    const [clinic, accounts] = await Promise.all([
      this.db.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, brandDisplayName: true } }),
      this.db.cashAccount.findMany({ where: { clinicId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const base = { clinicName: clinic.brandDisplayName ?? clinic.name, branchName: branch.name, from, to, accounts };
    if (!register) return { ...base, initial: new Map<string, number>(), movements: [], sessions: [], names: new Map<string, string>() };
    const [initial, movements, sessions] = await Promise.all([
      this.balances(this.db, register.id, start),
      this.db.cashMovement.findMany({ where: { registerId: register.id, occurredAt: { gte: start, lt: end } }, include: { account: true, category: true }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] }),
      this.db.cashSession.findMany({ where: { registerId: register.id, status: 'CLOSED', closedAt: { gte: start, lt: end } }, include: { accounts: true }, orderBy: { closedAt: 'asc' } }),
    ]);
    const names = await this.names([...movements.flatMap((m) => [m.createdById, m.voidedById]), ...sessions.flatMap((s) => [s.openedById, s.closedById])]);
    return { ...base, initial, movements, sessions, names };
  }

  async auditReport(actor: AuthPrincipal, from: string, to: string, meta: RequestMeta) {
    const { clinicId, branchId } = cashScope(actor);
    await this.audited(actor, clinicId, branchId, meta, AuditAction.CashReportExported, 'CashReport', clinicId, { from, to });
  }
}
