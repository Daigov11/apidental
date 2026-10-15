import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MaintenanceService } from '../src/maintenance/maintenance.service.js';
import { actorIn, createTestContext, Fixtures, type TestContext, uniq } from './helpers/app.js';

// Lotes pequeños para probar el tope por ejecución.
process.env['MAINTENANCE_BATCH_SIZE'] = '10';
process.env['MAINTENANCE_MAX_BATCHES'] = '2';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('Mantenimiento de seguridad (depuración)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  let svc: MaintenanceService;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
    svc = ctx.app.get(MaintenanceService);
  });
  afterAll(() => ctx.close());

  /** Sesión con un refresh token (y opcionalmente una prueba de reautenticación). */
  async function session(userId: string, over: { revokedAt?: Date | null; absoluteExpiresAt?: Date; tokenExpiresAt?: Date; proof?: Date } = {}) {
    const s = await ctx.db.authSession.create({
      data: {
        userId,
        absoluteExpiresAt: over.absoluteExpiresAt ?? new Date(Date.now() + 5 * 86_400_000),
        revokedAt: over.revokedAt ?? null,
        revokedReason: over.revokedAt ? 'LOGOUT' : null,
      },
    });
    await ctx.db.refreshToken.create({
      data: { sessionId: s.id, tokenHash: sha(uniq('rt')), expiresAt: over.tokenExpiresAt ?? new Date(Date.now() + 3_600_000), status: over.revokedAt ? 'REVOKED' : 'ACTIVE' },
    });
    if (over.proof) {
      await ctx.db.reauthProof.create({
        data: { userId, sessionId: s.id, purpose: 'CLOSE_CLINICAL_NOTE', tokenHash: sha(uniq('rp')), expiresAt: over.proof },
      });
    }
    return s;
  }

  async function invitation(over: { status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'; ageDays: number; expiresInDays?: number }, creatorId: string, clinicId: string) {
    const role = await ctx.db.role.findUniqueOrThrow({ where: { code: 'ASSISTANT' } });
    const created = daysAgo(over.ageDays);
    return ctx.db.invitation.create({
      data: {
        email: `${uniq('m')}@test.pe`,
        roleId: role.id,
        clinicId,
        tokenHash: sha(uniq('inv')),
        status: over.status,
        pendingKey: over.status === 'PENDING' ? uniq('pk') : null,
        expiresAt: new Date(created.getTime() + (over.expiresInDays ?? 3) * 86_400_000),
        createdById: creatorId,
        createdAt: created,
      },
    });
  }

  async function recovery(userId: string, over: { status: 'PENDING' | 'USED' | 'REVOKED' | 'EXPIRED'; ageDays: number }) {
    return ctx.db.passwordRecovery.create({
      data: {
        userId,
        tokenHash: sha(uniq('pr')),
        status: over.status,
        pendingKey: over.status === 'PENDING' ? userId : null,
        expiresAt: new Date(daysAgo(over.ageDays).getTime() + 30 * 60_000),
        createdAt: daysAgo(over.ageDays),
      },
    });
  }

  it('vence lo caducado y depura lo cerrado que superó su retención, sin tocar lo vigente ni lo que debe conservarse', async () => {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const user = await fx.user();
    const other = await fx.user();

    // --- sesiones ---
    const active = await session(user.id);
    const expiredAbsolute = await session(user.id, { absoluteExpiresAt: new Date(Date.now() - 1000) });
    const idleExpired = await session(user.id, { tokenExpiresAt: new Date(Date.now() - 1000) });
    const oldRevoked = await session(user.id, { revokedAt: daysAgo(40), proof: daysAgo(40) });
    const recentRevoked = await session(user.id, { revokedAt: daysAgo(5) });
    const oldProofOnLiveSession = await ctx.db.reauthProof.create({
      data: { userId: other.id, sessionId: (await session(other.id)).id, purpose: 'CLOSE_CLINICAL_NOTE', tokenHash: sha(uniq('rp')), expiresAt: daysAgo(10), usedAt: daysAgo(10) },
    });
    const recentProof = await ctx.db.reauthProof.create({
      data: { userId: other.id, sessionId: (await session(other.id)).id, purpose: 'CLOSE_CLINICAL_NOTE', tokenHash: sha(uniq('rp')), expiresAt: new Date(Date.now() + 60_000) },
    });

    // --- invitaciones ---
    const invPendingValid = await invitation({ status: 'PENDING', ageDays: 0, expiresInDays: 3 }, admin.user.id, clinic.id);
    const invPendingStale = await invitation({ status: 'PENDING', ageDays: 10, expiresInDays: 3 }, admin.user.id, clinic.id);
    const invOldClosed = await invitation({ status: 'REVOKED', ageDays: 120 }, admin.user.id, clinic.id);
    const invOldAccepted = await invitation({ status: 'ACCEPTED', ageDays: 200 }, admin.user.id, clinic.id);
    const invRecentClosed = await invitation({ status: 'ACCEPTED', ageDays: 20 }, admin.user.id, clinic.id);

    // --- recuperaciones ---
    const recPendingStale = await recovery(user.id, { status: 'PENDING', ageDays: 3 });
    const recOldUsed = await recovery(other.id, { status: 'USED', ageDays: 60 });
    const recRecentUsed = await recovery(other.id, { status: 'USED', ageDays: 10 });

    // --- aprovisionamiento antiguo: NO se depura nunca ---
    const oldRecord = await ctx.db.provisioningRecord.create({
      data: {
        clinicId: clinic.id, kind: 'FIRST_CLINICAL_DIRECTOR', status: 'CONSUMED', designeeName: 'X', designeeEmail: 'x@test.pe', authorizedByName: 'Y',
        authorizedByPosition: 'Z', authorizedByDocumentType: 'DNI', authorizedByDocumentNumber: '12345678', authorizationReference: 'Acta antigua',
        authorizationDate: daysAgo(400), recordedById: admin.user.id, createdAt: daysAgo(400), expiresAt: daysAgo(370),
      },
    });
    const auditBefore = await ctx.db.auditLog.count();
    const exists = {
      session: (id: string) => ctx.db.authSession.count({ where: { id } }),
      proof: (id: string) => ctx.db.reauthProof.count({ where: { id } }),
      inv: (id: string) => ctx.db.invitation.count({ where: { id } }),
      rec: (id: string) => ctx.db.passwordRecovery.count({ where: { id } }),
    };

    // ---- dry-run: cuenta, pero no modifica nada ----
    const dry = await svc.run({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.expired.sessions).toBeGreaterThanOrEqual(2);
    expect(dry.purged.sessions).toBeGreaterThanOrEqual(1);
    expect(dry.purged.invitations).toBeGreaterThanOrEqual(2);
    expect(await exists.session(oldRevoked.id)).toBe(1);
    expect(await exists.inv(invOldClosed.id)).toBe(1);
    expect((await ctx.db.authSession.findUniqueOrThrow({ where: { id: expiredAbsolute.id } })).revokedAt).toBeNull();
    expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: invPendingStale.id } })).status).toBe('PENDING');
    expect(await ctx.db.auditLog.count()).toBe(auditBefore); // el dry-run no audita

    // ---- ejecución real ----
    const report = await svc.run();
    expect(report.dryRun).toBe(false);
    expect(report.expired.sessions).toBeGreaterThanOrEqual(2);
    expect(report.expired.invitations).toBeGreaterThanOrEqual(1);
    expect(report.expired.passwordRecoveries).toBeGreaterThanOrEqual(1);
    expect(report.purged.sessions).toBeGreaterThanOrEqual(1);
    expect(report.purged.reauthProofs).toBeGreaterThanOrEqual(1);
    expect(report.purged.invitations).toBeGreaterThanOrEqual(2);
    expect(report.purged.passwordRecoveries).toBeGreaterThanOrEqual(1);

    // vencidas (se conservan hasta superar la retención)
    for (const s of [expiredAbsolute, idleExpired]) {
      const row = await ctx.db.authSession.findUniqueOrThrow({ where: { id: s.id } });
      expect(row).toMatchObject({ revokedReason: 'EXPIRED' });
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(await ctx.db.refreshToken.count({ where: { sessionId: s.id, status: 'ACTIVE' } })).toBe(0);
    }
    expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: invPendingStale.id } })).status).toBe('EXPIRED');
    expect((await ctx.db.passwordRecovery.findUniqueOrThrow({ where: { id: recPendingStale.id } })).status).toBe('EXPIRED');

    // depuradas (con su cascada)
    expect(await exists.session(oldRevoked.id)).toBe(0);
    expect(await ctx.db.refreshToken.count({ where: { sessionId: oldRevoked.id } })).toBe(0);
    expect(await ctx.db.reauthProof.count({ where: { sessionId: oldRevoked.id } })).toBe(0);
    expect(await exists.proof(oldProofOnLiveSession.id)).toBe(0);
    expect(await exists.inv(invOldClosed.id)).toBe(0);
    expect(await exists.inv(invOldAccepted.id)).toBe(0);
    expect(await exists.rec(recOldUsed.id)).toBe(0);

    // conservadas: lo vigente, lo reciente y el registro de aprovisionamiento
    for (const s of [active, recentRevoked]) expect(await exists.session(s.id)).toBe(1);
    expect((await ctx.db.authSession.findUniqueOrThrow({ where: { id: active.id } })).revokedAt).toBeNull();
    expect(await exists.proof(recentProof.id)).toBe(1);
    for (const i of [invPendingValid, invPendingStale, invRecentClosed]) expect(await exists.inv(i.id)).toBe(1);
    expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: invPendingValid.id } })).status).toBe('PENDING');
    for (const r of [recPendingStale, recRecentUsed]) expect(await exists.rec(r.id)).toBe(1);
    expect(await ctx.db.provisioningRecord.count({ where: { id: oldRecord.id } })).toBe(1);
    expect(await ctx.db.user.count({ where: { id: { in: [user.id, other.id, admin.user.id] } } })).toBe(3); // los usuarios no se tocan

    // auditoría: se conserva TODA y se agrega un resumen solo con contadores
    expect(await ctx.db.auditLog.count()).toBeGreaterThan(auditBefore);
    const [log] = await ctx.db.auditLog.findMany({ where: { action: 'MAINTENANCE_PURGE' }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(log).toMatchObject({ entity: 'System', userId: null });
    const text = JSON.stringify(log!.summary);
    expect(text).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}|rt_|inv_|pr_|rp_/);
    expect(log!.summary).toMatchObject({ truncated: expect.any(Boolean), retentionDays: { sessionsDays: 30, reauthDays: 7, invitationsDays: 90, recoveriesDays: 30 } });

    // idempotente: repetirlo no toca nada de lo ya procesado
    await svc.run();
    expect(await exists.session(oldRevoked.id)).toBe(0);
    expect(await exists.session(active.id)).toBe(1);
    expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: invPendingStale.id } })).status).toBe('EXPIRED');
  });

  it('respeta el tope de lotes por ejecución y avisa (truncated); las siguientes ejecuciones terminan el trabajo', async () => {
    const user = await fx.user();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push((await session(user.id, { revokedAt: daysAgo(45) })).id);
    const first = await svc.run();
    expect(first.truncated).toBe(true); // lote 10 × 2 lotes = 20 < 25
    const remaining = await ctx.db.authSession.count({ where: { id: { in: ids } } });
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(25);
    for (let i = 0; i < 5 && (await ctx.db.authSession.count({ where: { id: { in: ids } } })) > 0; i++) await svc.run();
    expect(await ctx.db.authSession.count({ where: { id: { in: ids } } })).toBe(0);
  });

  it('la base de datos impide depurar invitaciones pendientes o recientes aunque se intente por SQL', async () => {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const pendingOld = await invitation({ status: 'PENDING', ageDays: 200, expiresInDays: 400 }, admin.user.id, clinic.id);
    const recent = await invitation({ status: 'REVOKED', ageDays: 5 }, admin.user.id, clinic.id);
    await expect(ctx.db.invitation.delete({ where: { id: pendingOld.id } })).rejects.toThrow(/solo se purgan/);
    await expect(ctx.db.invitation.delete({ where: { id: recent.id } })).rejects.toThrow(/solo se purgan/);
    await expect(ctx.db.$executeRaw`DELETE FROM invitations WHERE id = ${recent.id}`).rejects.toThrow(/solo se purgan/);
    expect(await ctx.db.invitation.count({ where: { id: { in: [pendingOld.id, recent.id] } } })).toBe(2);
  });

  const cli = join(process.cwd(), 'dist', 'maintenance', 'cli.js');
  it.skipIf(!existsSync(cli))('la CLI documentada (node dist/maintenance/cli.js --dry-run) imprime un resumen JSON sin secretos', () => {
    const out = execFileSync('node', [cli, '--dry-run'], {
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();
    const report = JSON.parse(out.split('\n').at(-1)!);
    expect(report).toMatchObject({ dryRun: true, truncated: expect.any(Boolean) });
    expect(Object.keys(report.expired).sort()).toEqual(['invitations', 'passwordRecoveries', 'provisioningRecords', 'sessions']);
    expect(Object.keys(report.purged).sort()).toEqual(['invitations', 'passwordRecoveries', 'reauthProofs', 'sessions']);
    expect(out).not.toMatch(/@|rt_|inv_|pr_|eyJ/);
  });
});
