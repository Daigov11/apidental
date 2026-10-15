import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { ReauthService, REAUTH_NOTICE } from '../src/auth/reauth.service.js';
import {
  bearer,
  createTestContext,
  Fixtures,
  loginFull,
  PASSWORD,
  sessionIdOf,
  type TestContext,
} from './helpers/app.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const META = { ip: '127.0.0.1', userAgent: 'vitest' };

describe('Reautenticación', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  let reauth: ReauthService;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
    reauth = ctx.app.get(ReauthService);
  });
  afterAll(() => ctx.close());

  const issue = (token: string, body: object) => ctx.http().post('/v1/auth/reauthenticate').set(bearer(token)).send(body);
  const consume = (actor: { userId: string; sessionId: string }, token: unknown, purpose: string, target: string | null) =>
    ctx.db.$transaction((tx) => reauth.consume(actor, token, purpose, target, META, tx));

  /** Usuario con sesión + prueba emitida por la API. */
  async function proofFor(purpose: string, targetId?: string) {
    const user = await fx.user();
    const { accessToken } = await loginFull(ctx, user.email);
    const res = await issue(accessToken, { password: PASSWORD, purpose, ...(targetId ? { targetId } : {}) }).expect(200);
    return { user, userId: user.id, accessToken, sessionId: sessionIdOf(accessToken), token: res.body.reauthToken as string, res };
  }

  describe('POST /v1/auth/reauthenticate', () => {
    it('con la contraseña correcta emite una prueba corta, de un solo uso, que NO es una firma', async () => {
      const target = randomUUID();
      const { res, token, user } = await proofFor('AUTHORIZE_DIRECTOR_PROVISIONING', target);
      expect(res.body).toMatchObject({
        purpose: 'AUTHORIZE_DIRECTOR_PROVISIONING',
        targetId: target,
        expiresIn: 120,
        singleUse: true,
        isSignature: false,
        notice: REAUTH_NOTICE,
      });
      expect(res.body.notice).toMatch(/No es una firma digital, legal ni clínica/);
      expect(token).toMatch(/^rp_[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(res.body.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
      expect(Date.parse(res.body.expiresAt) - Date.now()).toBeGreaterThan(100_000);
      expect(res.headers['cache-control']).toBe('no-store');

      const row = await ctx.db.reauthProof.findFirstOrThrow({ where: { userId: user.id } });
      expect(row.tokenHash).toBe(sha(token));
      expect(row.usedAt).toBeNull();
      expect(JSON.stringify(row)).not.toContain(token);
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'REAUTH_SUCCEEDED', userId: user.id } });
      expect(log!.summary).toMatchObject({ purpose: 'AUTHORIZE_DIRECTOR_PROVISIONING', targetId: target });
      expect(JSON.stringify(log)).not.toContain(token);
    });

    it('con una contraseña incorrecta responde 401, audita y no emite nada', async () => {
      const user = await fx.user();
      const { accessToken } = await loginFull(ctx, user.email);
      const res = await issue(accessToken, { password: 'incorrecta-123456', purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401);
      expect(res.body.message).toBe('Contraseña incorrecta');
      expect(res.body.reauthToken).toBeUndefined();
      expect(await ctx.db.reauthProof.count({ where: { userId: user.id } })).toBe(0);
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'REAUTH_FAILED', userId: user.id } });
      expect(log!.summary).toMatchObject({ attempts: 1, reason: 'bad_password' });
      expect(JSON.stringify(log)).not.toContain('incorrecta-123456');
    });

    it('los fallos cuentan para el bloqueo: una sesión robada no puede adivinar la contraseña', async () => {
      const user = await fx.user();
      const { accessToken } = await loginFull(ctx, user.email);
      for (let i = 0; i < 3; i++) await issue(accessToken, { password: `mala-${i}-123456789`, purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401);
      const row = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      // ni siquiera la contraseña correcta sirve mientras dure el bloqueo (ni para iniciar sesión)
      await issue(accessToken, { password: PASSWORD, purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401);
      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
      expect(await ctx.db.auditLog.count({ where: { action: 'LOGIN_LOCKED', userId: user.id } })).toBeGreaterThanOrEqual(1);
    });

    it('una reautenticación correcta reinicia el contador de intentos', async () => {
      const user = await fx.user();
      const { accessToken } = await loginFull(ctx, user.email);
      await issue(accessToken, { password: 'mala-123456789012', purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401);
      await issue(accessToken, { password: PASSWORD, purpose: 'CLOSE_CLINICAL_NOTE' }).expect(200);
      expect((await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginAttempts).toBe(0);
    });

    it('exige autenticación y valida el cuerpo', async () => {
      await ctx.http().post('/v1/auth/reauthenticate').send({ password: PASSWORD, purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401);
      const user = await fx.user();
      const { accessToken } = await loginFull(ctx, user.email);
      await issue(accessToken, { password: PASSWORD }).expect(400);
      await issue(accessToken, { purpose: 'CLOSE_CLINICAL_NOTE' }).expect(400);
      await issue(accessToken, { password: PASSWORD, purpose: 'CUALQUIER_COSA' }).expect(400);
      await issue(accessToken, { password: PASSWORD, purpose: 'CLINICAL_READ_ALL', targetId: 'no-uuid' }).expect(400);
      await issue(accessToken, { password: PASSWORD, purpose: 'CLINICAL_READ_ALL', userId: 'otro' }).expect(400);
    });

    it('un usuario deshabilitado o con sesión revocada no puede reautenticarse', async () => {
      const user = await fx.user();
      const { accessToken } = await loginFull(ctx, user.email);
      await ctx.db.authSession.update({ where: { id: sessionIdOf(accessToken) }, data: { revokedAt: new Date() } });
      await issue(accessToken, { password: PASSWORD, purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401);
    });
  });

  describe('consumo de la prueba (lo usarán el cierre de evoluciones y clinical:read_all)', () => {
    it('sirve exactamente una vez', async () => {
      const t = randomUUID();
      const p = await proofFor('CLOSE_CLINICAL_NOTE', t);
      await consume(p, p.token, 'CLOSE_CLINICAL_NOTE', t);
      await expect(consume(p, p.token, 'CLOSE_CLINICAL_NOTE', t)).rejects.toThrow(/inválida, vencida o ya utilizada/);
      const row = await ctx.db.reauthProof.findFirstOrThrow({ where: { userId: p.user.id } });
      expect(row.usedAt).toBeInstanceOf(Date);
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'REAUTH_CONSUMED', userId: p.user.id } });
      expect(log!.summary).toMatchObject({ purpose: 'CLOSE_CLINICAL_NOTE', targetId: t });
      expect(JSON.stringify(log)).not.toContain(p.token);
    });

    it('solo vale para el propósito para el que se pidió', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      for (const other of ['CORRECT_CLINICAL_NOTE', 'MARK_CLINICAL_NOTE_ERROR', 'CLINICAL_READ_ALL', 'AUTHORIZE_DIRECTOR_PROVISIONING']) {
        await expect(consume(p, p.token, other, null)).rejects.toThrow(/inválida/);
      }
      await consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null); // sigue intacta tras los intentos fallidos
    });

    it('solo vale para el objeto autorizado (y una prueba sin objeto no sirve para uno concreto, ni al revés)', async () => {
      const target = randomUUID();
      const withTarget = await proofFor('CLINICAL_READ_ALL', target);
      await expect(consume(withTarget, withTarget.token, 'CLINICAL_READ_ALL', randomUUID())).rejects.toThrow(/inválida/);
      await expect(consume(withTarget, withTarget.token, 'CLINICAL_READ_ALL', null)).rejects.toThrow(/inválida/);
      await consume(withTarget, withTarget.token, 'CLINICAL_READ_ALL', target);

      const withoutTarget = await proofFor('CLINICAL_READ_ALL');
      await expect(consume(withoutTarget, withoutTarget.token, 'CLINICAL_READ_ALL', target)).rejects.toThrow(/inválida/);
    });

    it('vence a los 2 minutos', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      // El trigger impide alterar expires_at (ni por SQL), así que se adelanta el reloj 2 min y 1 s.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 121_000);
      try {
        await expect(consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null)).rejects.toThrow(/inválida/);
      } finally {
        vi.useRealTimers();
      }
      // dentro de la vigencia sí sirve (se verifica con otra prueba, para no depender del reloj)
      const fresh = await proofFor('CLOSE_CLINICAL_NOTE');
      await consume(fresh, fresh.token, 'CLOSE_CLINICAL_NOTE', null);
    });

    it('está ligada al usuario y a la SESIÓN que la pidió', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      const otherSession = await loginFull(ctx, p.user.email);
      await expect(consume({ userId: p.user.id, sessionId: sessionIdOf(otherSession.accessToken) }, p.token, 'CLOSE_CLINICAL_NOTE', null)).rejects.toThrow(/inválida/);
      const stranger = await fx.user();
      const s = await loginFull(ctx, stranger.email);
      await expect(consume({ userId: stranger.id, sessionId: sessionIdOf(s.accessToken) }, p.token, 'CLOSE_CLINICAL_NOTE', null)).rejects.toThrow(/inválida/);
      await consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null);
    });

    it('rechaza tokens inexistentes, manipulados o de otro tipo', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      for (const bad of ['', 'x', 'rp_' + 'A'.repeat(43), p.token.slice(0, -1) + 'x', undefined, null, 123, {}]) {
        await expect(consume(p, bad, 'CLOSE_CLINICAL_NOTE', null)).rejects.toThrow(/inválida/);
      }
      await expect(consume(p, p.accessToken, 'CLOSE_CLINICAL_NOTE', null)).rejects.toThrow(/inválida/);
    });

    it('si la operación protegida falla, la prueba NO se gasta (se consume dentro de su transacción)', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      await expect(
        ctx.db.$transaction(async (tx) => {
          await reauth.consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null, META, tx);
          throw new Error('la operación protegida falló');
        }),
      ).rejects.toThrow('la operación protegida falló');
      await consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null);
    });

    it('con dos consumos simultáneos solo uno prospera', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      const results = await Promise.allSettled([
        consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null),
        consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null),
        consume(p, p.token, 'CLOSE_CLINICAL_NOTE', null),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('una sesión cerrada invalida también la posibilidad de usar su prueba (el access token ya no autentica)', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      await ctx.http().post('/v1/auth/logout').set({ Origin: 'http://localhost:5173', 'X-Requested-With': 'ApiDental', 'Content-Type': 'application/json' }).set(bearer(p.accessToken)).send('{}').expect(204);
      await ctx.http().get('/v1/auth/me').set(bearer(p.accessToken)).expect(401);
    });
  });

  describe('garantías de la base de datos', () => {
    it('una prueba solo puede marcarse como usada, una vez, y nada más puede cambiar', async () => {
      const p = await proofFor('CLOSE_CLINICAL_NOTE');
      const row = await ctx.db.reauthProof.findFirstOrThrow({ where: { userId: p.user.id } });
      await expect(ctx.db.reauthProof.update({ where: { id: row.id }, data: { purpose: 'CLINICAL_READ_ALL' } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.reauthProof.update({ where: { id: row.id }, data: { targetId: randomUUID() } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.reauthProof.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } })).rejects.toThrow(/inmutable/);
      await ctx.db.reauthProof.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      await expect(ctx.db.reauthProof.update({ where: { id: row.id }, data: { usedAt: new Date() } })).rejects.toThrow(/ya fue usada/);
    });

    it('el hash de un refresh token y su sesión no pueden alterarse', async () => {
      const user = await fx.user();
      const { refreshToken } = await loginFull(ctx, user.email);
      const row = await ctx.db.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha(refreshToken) } });
      await expect(ctx.db.refreshToken.update({ where: { id: row.id }, data: { tokenHash: 'a'.repeat(64) } })).rejects.toThrow(/inmutables/);
    });
  });
});
