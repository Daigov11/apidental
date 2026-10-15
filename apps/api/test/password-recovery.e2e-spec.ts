import { createHash } from 'node:crypto';
import { ReauthService } from '../src/auth/reauth.service.js';
import {
  acceptReq,
  actorIn,
  bearer,
  confirmRecovery,
  createTestContext,
  devOutbox,
  Fixtures,
  inviteOk,
  loginFull,
  PASSWORD,
  reauthProofFor,
  recoveryReq,
  refreshWith,
  requestRecovery,
  sessionIdOf,
  settleRecoveries,
  type TestContext,
  uniq,
  validateRecovery,
} from './helpers/app.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const NEW_PW = 'Nueva-Clave-Segura-2026';
const strip = (b: Record<string, unknown>) => ({ ...b, requestId: 0, timestamp: 0, path: 0 });

describe('Recuperación de contraseña', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const rowsOf = (userId: string) => ctx.db.passwordRecovery.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const login = (email: string, password: string) => ctx.http().post('/v1/auth/login').send({ email, password });

  describe('solicitud: siempre neutral', () => {
    it('responde exactamente igual exista o no el correo, esté activa o deshabilitada la cuenta', async () => {
      const active = await fx.user();
      const disabled = await fx.user({ status: 'DISABLED' });
      const cases = [active.email, `${uniq('noexiste')}@test.pe`, disabled.email, active.email.toUpperCase()];
      const responses = [];
      for (const email of cases) {
        responses.push(await recoveryReq(ctx, email));
        await settleRecoveries(ctx); // secuencial: dos solicitudes a la vez para la misma cuenta se resuelven en silencio
      }
      for (const r of responses) expect(r.status).toBe(202);
      const bodies = new Set(responses.map((r) => JSON.stringify(r.body)));
      expect(bodies.size).toBe(1);
      expect(responses[0]!.body).toEqual({ message: 'Si el correo corresponde a una cuenta activa, le enviaremos instrucciones para restablecer su contraseña.' });
      const headerSet = new Set(responses.map((r) => JSON.stringify([r.headers['content-type'], r.headers['content-length'], r.headers['cache-control']])));
      expect(headerSet.size).toBe(1);
      for (const email of cases) expect(JSON.stringify(responses.find((r) => r)!.body)).not.toContain(email);

      // solo la cuenta activa generó un registro y un envío
      expect(await rowsOf(active.id)).toHaveLength(2); // dos solicitudes (minúsculas y mayúsculas) sin enfriamiento en pruebas
      expect(await rowsOf(disabled.id)).toHaveLength(0);
      expect(await ctx.db.passwordRecovery.count({ where: { user: { email: cases[1]! } } })).toBe(0);
      expect(devOutbox(ctx).last('password_recovery', disabled.email)).toBeUndefined();
      expect(devOutbox(ctx).last('password_recovery', cases[1]!)).toBeUndefined();
    });

    it('la respuesta nunca contiene el token ni el enlace; solo viaja por el canal de entrega', async () => {
      const user = await fx.user();
      const res = await recoveryReq(ctx, user.email).expect(202);
      await settleRecoveries(ctx);
      const message = devOutbox(ctx).last('password_recovery', user.email)!;
      expect(message.url).toMatch(/^http:\/\/localhost:5173\/admin\/restablecer-contrasena#token=pr_[A-Za-z0-9_-]{43}$/);
      const token = message.url.split('#token=')[1]!;
      expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toContain(token);
      expect(JSON.stringify(res.body)).not.toMatch(/token|url|link|enlace/i);
      const [row] = await rowsOf(user.id);
      expect(row).toMatchObject({ status: 'PENDING', pendingKey: user.id, deliveryStatus: 'SENT', deliveryAttempts: 1 });
      expect(row!.tokenHash).toBe(sha(token));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(Date.parse(row!.expiresAt.toISOString()) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
      expect(Date.parse(row!.expiresAt.toISOString()) - Date.now()).toBeGreaterThan(29 * 60_000);
    });

    it('audita la solicitud y el envío sin token, hash ni correo', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      const logs = await ctx.db.auditLog.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
      expect(logs.map((l) => l.action)).toEqual(['PASSWORD_RECOVERY_REQUESTED', 'PASSWORD_RECOVERY_SENT']);
      expect(logs[1]!.summary).toEqual({ channel: 'dev' });
      const dump = JSON.stringify(logs);
      for (const secret of [token, sha(token), user.email]) expect(dump).not.toContain(secret);
    });

    it('pedir otra recuperación revoca la anterior: solo la última sirve', async () => {
      const user = await fx.user();
      const first = await requestRecovery(ctx, user.email);
      const second = await requestRecovery(ctx, user.email);
      expect(second).not.toBe(first);
      const rows = await rowsOf(user.id);
      expect(rows.map((r) => r.status)).toEqual(['REVOKED', 'PENDING']);
      expect(rows[0]).toMatchObject({ revokedReason: 'superseded', pendingKey: null });
      await validateRecovery(ctx, first).expect(404);
      await confirmRecovery(ctx, first, NEW_PW).expect(404);
      await confirmRecovery(ctx, second, NEW_PW).expect(200);
    });

    it('tope diario por cuenta: las solicitudes de más se ignoran en silencio (sin cambiar la respuesta)', async () => {
      const user = await fx.user();
      const statuses = [];
      for (let i = 0; i < 7; i++) {
        statuses.push((await recoveryReq(ctx, user.email)).status);
        await settleRecoveries(ctx);
      }
      expect(new Set(statuses)).toEqual(new Set([202]));
      expect(await rowsOf(user.id)).toHaveLength(5);
    });

    it('valida el formato del correo y rechaza campos desconocidos', async () => {
      await recoveryReq(ctx, 'no-es-correo').expect(400);
      await ctx.http().post('/v1/auth/password-recovery').send({}).expect(400);
      await ctx.http().post('/v1/auth/password-recovery').send({ email: 'a@b.pe', isAdmin: true }).expect(400);
    });
  });

  describe('restablecimiento', () => {
    it('token válido: cambia la contraseña, NO inicia sesión y el enlace queda gastado', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      const valid = await validateRecovery(ctx, token).expect(200);
      expect(valid.body.valid).toBe(true);

      const res = await confirmRecovery(ctx, token, NEW_PW).expect(200);
      expect(res.body).toEqual({ reset: true });
      expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toMatch(/accessToken|set-cookie|apidental_rt/i);
      const row = (await rowsOf(user.id))[0]!;
      expect(row).toMatchObject({ status: 'USED', pendingKey: null });
      expect(row.usedAt).toBeInstanceOf(Date);
      expect(row.usedIp).toBeTruthy();

      await login(user.email, NEW_PW).expect(200);
      await login(user.email, PASSWORD).expect(401);
      const hash = (await ctx.db.user.findUniqueOrThrow({ where: { id: user.id }, omit: { passwordHash: false } })).passwordHash;
      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(hash).not.toContain(NEW_PW);
    });

    it('invalida TODAS las sesiones y refresh tokens del usuario y sus pruebas de reautenticación', async () => {
      const user = await fx.user();
      const s1 = await loginFull(ctx, user.email);
      const s2 = await loginFull(ctx, user.email);
      const other = await loginFull(ctx, (await fx.user()).email); // sesión de OTRO usuario: no se toca
      const proof = await reauthProofFor(ctx, s1.accessToken, 'CLOSE_CLINICAL_NOTE');
      const token = await requestRecovery(ctx, user.email);
      await confirmRecovery(ctx, token, NEW_PW).expect(200);

      for (const s of [s1, s2]) {
        await ctx.http().get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
        await refreshWith(ctx, s.refreshToken).expect(401);
      }
      await ctx.http().get('/v1/auth/me').set(bearer(other.accessToken)).expect(200);
      const sessions = await ctx.db.authSession.findMany({ where: { userId: user.id } });
      expect(sessions.every((s) => s.revokedReason === 'PASSWORD_RESET' && s.revokedAt)).toBe(true);
      expect(await ctx.db.refreshToken.count({ where: { session: { userId: user.id }, status: 'ACTIVE' } })).toBe(0);
      // la prueba de reautenticación pendiente ya no sirve
      const row = await ctx.db.reauthProof.findFirstOrThrow({ where: { userId: user.id } });
      expect(row.usedAt).toBeInstanceOf(Date);
      const s3 = await loginFull(ctx, user.email, NEW_PW);
      await expect(
        ctx.db.$transaction((tx) => ctx.app.get(ReauthService).consume({ userId: user.id, sessionId: sessionIdOf(s3.accessToken) }, proof, 'CLOSE_CLINICAL_NOTE', null, { ip: null, userAgent: null }, tx)),
      ).rejects.toThrow(/inválida/);
    });

    it('revoca las invitaciones pendientes dirigidas a la cuenta y cualquier otra recuperación pendiente', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const user = await fx.user();
      const pending = await inviteOk(ctx, admin.token, { email: user.email, roleCode: 'DENTIST' });
      const token = await requestRecovery(ctx, user.email);
      await confirmRecovery(ctx, token, NEW_PW).expect(200);
      expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('REVOKED');
      await acceptReq(ctx, pending.token, { password: NEW_PW }).expect(404);
      const logs = await ctx.db.auditLog.findMany({ where: { userId: user.id, action: 'PASSWORD_RECOVERY_COMPLETED' } });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.summary).toEqual({ sessionsRevoked: 0, invitationsRevoked: 1, recoveriesRevoked: 0 });
      expect(await ctx.db.auditLog.count({ where: { entityId: pending.id, action: 'INVITATION_REVOKED' } })).toBe(1);
    });

    it('restablecer limpia el bloqueo por intentos fallidos', async () => {
      const user = await fx.user();
      for (let i = 0; i < 3; i++) await login(user.email, `Incorrecta-${i}-12345`).expect(401);
      expect((await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).lockedUntil).not.toBeNull();
      const token = await requestRecovery(ctx, user.email);
      await confirmRecovery(ctx, token, NEW_PW).expect(200);
      expect(await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
      await login(user.email, NEW_PW).expect(200);
    });

    it('audita el restablecimiento sin contraseñas, tokens ni hashes', async () => {
      const user = await fx.user();
      await loginFull(ctx, user.email);
      const token = await requestRecovery(ctx, user.email);
      await confirmRecovery(ctx, token, NEW_PW).expect(200);
      const logs = await ctx.db.auditLog.findMany({ where: { userId: user.id } });
      const done = logs.find((l) => l.action === 'PASSWORD_RECOVERY_COMPLETED')!;
      expect(done.summary).toMatchObject({ sessionsRevoked: 1 });
      expect(done.ip).toBeTruthy();
      const dump = JSON.stringify(logs);
      for (const secret of [token, sha(token), NEW_PW, PASSWORD, user.email]) expect(dump).not.toContain(secret);
      expect(dump).not.toMatch(/argon2/);
    });
  });

  describe('política de contraseña (sin gastar el enlace)', () => {
    it('rechaza contraseñas cortas, repetitivas, iguales al correo o a la actual; el enlace sigue sirviendo', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      const bad: [string, RegExp][] = [
        ['corta', /al menos 12/],
        ['aaaaaaaaaaaaaaaa', /repetitiva/],
        ['abababababababab', /repetitiva/],
        [user.email, /igual a su correo/],
        [PASSWORD, /distinta de la actual/],
        ['x'.repeat(129), /./],
      ];
      for (const [password, expected] of bad) {
        const res = await confirmRecovery(ctx, token, password);
        expect(res.status, password.slice(0, 20)).toBe(400);
        expect(JSON.stringify(res.body.message), password.slice(0, 20)).toMatch(expected);
        expect(JSON.stringify(res.body)).not.toContain(password.length > 20 ? password : '\u0000');
      }
      expect((await rowsOf(user.id))[0]!.status).toBe('PENDING');
      await login(user.email, PASSWORD).expect(200); // la contraseña no cambió
      await confirmRecovery(ctx, token, NEW_PW).expect(200);
    });
  });

  describe('token expirado, revocado, reutilizado, manipulado o inexistente', () => {
    it('expirado: se rechaza, se marca EXPIRED una sola vez y la contraseña no cambia', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      await ctx.db.passwordRecovery.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const a = await confirmRecovery(ctx, token, NEW_PW).expect(404);
      expect(a.body.message).toBe('Enlace de recuperación inválido o vencido');
      await validateRecovery(ctx, token).expect(404);
      await confirmRecovery(ctx, token, NEW_PW).expect(404);
      const row = (await rowsOf(user.id))[0]!;
      expect(row).toMatchObject({ status: 'EXPIRED', pendingKey: null });
      expect(row.expiredAt).toBeInstanceOf(Date);
      expect(await ctx.db.auditLog.count({ where: { entityId: row.id, action: 'PASSWORD_RECOVERY_EXPIRED' } })).toBe(1);
      await login(user.email, PASSWORD).expect(200);
    });

    it('reutilizado: el segundo uso falla igual que un token inexistente y queda auditado', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      await confirmRecovery(ctx, token, NEW_PW).expect(200);
      const reused = await confirmRecovery(ctx, token, 'Otra-Clave-Distinta-77').expect(404);
      const unknown = await confirmRecovery(ctx, `pr_${'A'.repeat(43)}`, NEW_PW).expect(404);
      expect(strip(reused.body)).toEqual(strip(unknown.body));
      await login(user.email, NEW_PW).expect(200); // la clave no se volvió a cambiar
      const rejected = await ctx.db.auditLog.findMany({ where: { userId: user.id, action: 'PASSWORD_RECOVERY_REJECTED' } });
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.summary).toEqual({ reason: 'status_used' });
    });

    it('revocado: tras pedir otra o por deshabilitación de la cuenta ya no sirve', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      await ctx.db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
      await confirmRecovery(ctx, token, NEW_PW).expect(404);
      await validateRecovery(ctx, token).expect(404);
      expect((await ctx.db.auditLog.findMany({ where: { userId: user.id, action: 'PASSWORD_RECOVERY_REJECTED' } }))).toHaveLength(1);
      await ctx.db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
      await login(user.email, PASSWORD).expect(200);
    });

    it('manipulado o con otro formato: todas las variantes responden exactamente lo mismo', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      const variants = [
        token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
        token.slice(0, -4),
        token + 'x',
        token.replace('pr_', 'inv_'),
        token.replace('pr_', 'rt_'),
        token.toUpperCase(),
        `pr_${'0'.repeat(43)}`,
        '',
        'basura',
        ` ${token}`,
      ];
      const bodies = new Set<string>();
      for (const v of variants) {
        const c = await confirmRecovery(ctx, v, NEW_PW);
        const p = await validateRecovery(ctx, v);
        expect([c.status, p.status], JSON.stringify(v)).toEqual([404, 404]);
        bodies.add(JSON.stringify(strip(c.body)));
        bodies.add(JSON.stringify(strip(p.body)));
      }
      expect(bodies.size).toBe(1);
      await confirmRecovery(ctx, token, NEW_PW).expect(200); // el real no fue afectado
    });

    it('un token de recuperación no sirve como invitación ni como refresh, y viceversa', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const user = await fx.user();
      const recovery = await requestRecovery(ctx, user.email);
      const inv = await inviteOk(ctx, admin.token, { email: `${uniq('x')}@test.pe`, roleCode: 'DENTIST' });
      await acceptReq(ctx, recovery).expect(404);
      await refreshWith(ctx, recovery).expect(401);
      await confirmRecovery(ctx, inv.token, NEW_PW).expect(404);
    });

    it('dos confirmaciones simultáneas con el mismo token: solo una prospera', async () => {
      const user = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      const results = await Promise.all([confirmRecovery(ctx, token, NEW_PW), confirmRecovery(ctx, token, 'Otra-Clave-Larga-9999'), confirmRecovery(ctx, token, 'Tercera-Clave-Larga-8888')]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 404, 404]);
      expect(await ctx.db.passwordRecovery.count({ where: { userId: user.id, status: 'USED' } })).toBe(1);
    });

    it('valida el cuerpo de validate/confirm', async () => {
      await ctx.http().post('/v1/auth/password-recovery/confirm').send({}).expect(400);
      await ctx.http().post('/v1/auth/password-recovery/confirm').send({ token: 'x'.repeat(101), newPassword: NEW_PW }).expect(400);
      await ctx.http().post('/v1/auth/password-recovery/confirm').send({ token: 'a', newPassword: NEW_PW, userId: 'otro' }).expect(400);
      await ctx.http().post('/v1/auth/password-recovery/validate').send({}).expect(400);
    });
  });

  describe('garantías de la base de datos', () => {
    it('usuario, token y fecha son inmutables; una recuperación cerrada no se reabre', async () => {
      const user = await fx.user();
      const other = await fx.user();
      const token = await requestRecovery(ctx, user.email);
      const row = (await rowsOf(user.id))[0]!;
      await expect(ctx.db.passwordRecovery.update({ where: { id: row.id }, data: { userId: other.id } })).rejects.toThrow(/inmutables/);
      await expect(ctx.db.passwordRecovery.update({ where: { id: row.id }, data: { tokenHash: 'a'.repeat(64) } })).rejects.toThrow(/inmutables/);
      await expect(ctx.db.passwordRecovery.update({ where: { id: row.id }, data: { createdAt: new Date(0) } })).rejects.toThrow(/inmutables/);
      await confirmRecovery(ctx, token, NEW_PW).expect(200);
      await expect(ctx.db.passwordRecovery.update({ where: { id: row.id }, data: { status: 'PENDING' } })).rejects.toThrow(/no cambia de estado/);
    });

    it('solo se pueden eliminar recuperaciones cerradas y con más de 30 días (el mínimo lo impone la base de datos)', async () => {
      const user = await fx.user();
      const days = (n: number) => new Date(Date.now() - n * 86_400_000);
      const make = (status: 'PENDING' | 'USED', createdDaysAgo: number) =>
        ctx.db.passwordRecovery.create({
          data: { userId: user.id, tokenHash: sha(uniq('t')), status, pendingKey: status === 'PENDING' ? user.id : null, expiresAt: days(createdDaysAgo), createdAt: days(createdDaysAgo) },
        });
      const oldClosed = await make('USED', 40);
      const recentClosed = await make('USED', 5);
      const oldPending = await make('PENDING', 40);
      await expect(ctx.db.passwordRecovery.delete({ where: { id: recentClosed.id } })).rejects.toThrow(/solo se purgan/);
      await expect(ctx.db.passwordRecovery.delete({ where: { id: oldPending.id } })).rejects.toThrow(/solo se purgan/);
      await ctx.db.passwordRecovery.delete({ where: { id: oldClosed.id } });
      expect(await ctx.db.passwordRecovery.count({ where: { id: oldClosed.id } })).toBe(0);
    });
  });
});
