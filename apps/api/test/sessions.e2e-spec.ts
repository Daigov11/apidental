import {
  bearer,
  cookieHeader,
  COOKIE_NAME,
  csrfHeaders,
  createTestContext,
  Fixtures,
  loginFull,
  ORIGIN,
  PASSWORD,
  refreshTokenFrom,
  refreshWith,
  sessionIdOf,
  setCookies,
  type TestContext,
} from './helpers/app.js';
import { createHash } from 'node:crypto';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

describe('Sesiones: refresh token rotativo, reutilización, logout y CSRF', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const me = (token: string) => ctx.http().get('/v1/auth/me').set(bearer(token));

  describe('login entrega el refresh token solo por cookie', () => {
    it('cookie HttpOnly, SameSite=Strict, Path=/ y sin Domain (host-only); el cuerpo no contiene el token', async () => {
      const user = await fx.user();
      const { res, refreshToken, accessToken } = await loginFull(ctx, user.email);
      const line = setCookies(res).find((c) => c.startsWith(`${COOKIE_NAME}=`))!;
      expect(line).toMatch(/; HttpOnly/);
      expect(line).toMatch(/; SameSite=Strict/);
      expect(line).toMatch(/; Path=\//);
      expect(line).toMatch(/; Max-Age=28800/);
      expect(line).not.toMatch(/Domain=/i);
      expect(JSON.stringify(res.body)).not.toContain(refreshToken);
      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'contexts', 'expiresIn', 'tokenType', 'user']);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(sessionIdOf(accessToken)).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('en la base solo existe el SHA-256 del refresh token, nunca el token', async () => {
      const user = await fx.user();
      const { refreshToken, accessToken } = await loginFull(ctx, user.email);
      const rows = await ctx.db.refreshToken.findMany({ where: { sessionId: sessionIdOf(accessToken) } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toBe(sha(refreshToken));
      expect(rows[0]!.tokenHash).not.toBe(refreshToken);
      expect(rows[0]!.status).toBe('ACTIVE');
      expect(refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
      // ningún campo de ninguna tabla de sesión contiene el token en claro
      const dump = JSON.stringify(await ctx.db.authSession.findMany({ where: { userId: user.id } })) + JSON.stringify(rows);
      expect(dump).not.toContain(refreshToken);
    });

    it('cada inicio de sesión crea una sesión propia con IP y user agent', async () => {
      const user = await fx.user();
      const a = await loginFull(ctx, user.email);
      const b = await loginFull(ctx, user.email);
      expect(sessionIdOf(a.accessToken)).not.toBe(sessionIdOf(b.accessToken));
      const session = await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(a.accessToken) } });
      expect(session.ip).toBeTruthy();
      expect(session.revokedAt).toBeNull();
      expect(session.absoluteExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    });
  });

  describe('rotación', () => {
    it('cada refresh invalida el token anterior y entrega uno nuevo, con un access token válido', async () => {
      const user = await fx.user();
      const { refreshToken: t0, accessToken } = await loginFull(ctx, user.email);
      const res = await refreshWith(ctx, t0).expect(200);
      const t1 = refreshTokenFrom(res)!;
      expect(t1).toBeTruthy();
      expect(t1).not.toBe(t0);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, context: null });
      expect(JSON.stringify(res.body)).not.toContain(t1);
      expect(res.headers['cache-control']).toBe('no-store');
      await me(res.body.accessToken).expect(200);
      expect(sessionIdOf(res.body.accessToken)).toBe(sessionIdOf(accessToken));

      const rows = await ctx.db.refreshToken.findMany({ where: { sessionId: sessionIdOf(accessToken) }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.status).sort((a, b) => a.localeCompare(b))).toEqual(['ACTIVE', 'ROTATED']);
      const old = rows.find((r) => r.tokenHash === sha(t0))!;
      expect(old.status).toBe('ROTATED');
      expect(old.replacedById).toBe(rows.find((r) => r.tokenHash === sha(t1))!.id);
      expect(old.rotatedAt).toBeInstanceOf(Date);
    });

    it('permite encadenar renovaciones sucesivas', async () => {
      const user = await fx.user();
      let token = (await loginFull(ctx, user.email)).refreshToken;
      for (let i = 0; i < 4; i++) {
        const res = await refreshWith(ctx, token).expect(200);
        token = refreshTokenFrom(res)!;
      }
      expect(await ctx.db.refreshToken.count({ where: { status: 'ROTATED', session: { userId: user.id } } })).toBe(4);
    });

    it('restaura el contexto activo al renovar y lo descarta si dejó de ser válido', async () => {
      const clinic = await fx.clinic();
      const { user, assignment } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const { accessToken, refreshToken } = await loginFull(ctx, user.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(accessToken)).send({ clinicId: clinic.id }).expect(200);

      const r1 = await refreshWith(ctx, refreshToken).expect(200);
      expect(r1.body.context).toMatchObject({ platform: false, clinic: { id: clinic.id } });
      const ctxMe = await me(r1.body.accessToken).expect(200);
      expect(ctxMe.body.permissions).toContain('invitation:manage');

      await ctx.db.userAssignment.update({ where: { id: assignment.id }, data: { status: 'INACTIVE' } });
      const r2 = await refreshWith(ctx, refreshTokenFrom(r1)!).expect(200);
      expect(r2.body.context).toBeNull();
      expect((await me(r2.body.accessToken).expect(200)).body.context).toBeNull();
    });

    it('el contexto se guarda por sesión (otra sesión del mismo usuario no lo hereda)', async () => {
      const clinic = await fx.clinic();
      const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const a = await loginFull(ctx, user.email);
      const b = await loginFull(ctx, user.email);
      await ctx.http().post('/v1/auth/select-context').set(bearer(a.accessToken)).send({ clinicId: clinic.id }).expect(200);
      expect((await refreshWith(ctx, a.refreshToken).expect(200)).body.context).not.toBeNull();
      expect((await refreshWith(ctx, b.refreshToken).expect(200)).body.context).toBeNull();
    });
  });

  describe('detección de reutilización', () => {
    it('reusar un refresh token ya rotado revoca TODA la sesión (también el token legítimo y el access token)', async () => {
      const user = await fx.user();
      const { refreshToken: stolen, accessToken } = await loginFull(ctx, user.email);
      const legit = await refreshWith(ctx, stolen).expect(200);
      const legitToken = refreshTokenFrom(legit)!;
      await me(legit.body.accessToken).expect(200);

      // el atacante (o una copia) presenta el token viejo
      const replay = await refreshWith(ctx, stolen).expect(401);
      expect(replay.body.message).toBe('Sesión inválida o vencida');
      const cleared = setCookies(replay).find((c) => c.startsWith(`${COOKIE_NAME}=`))!;
      expect(cleared).toMatch(/^apidental_rt=;/);

      const sessionId = sessionIdOf(accessToken);
      const session = await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session).toMatchObject({ revokedReason: 'REUSE_DETECTED' });
      expect(session.revokedAt).toBeInstanceOf(Date);
      expect(await ctx.db.refreshToken.count({ where: { sessionId, status: 'ACTIVE' } })).toBe(0);

      // el token legítimo más reciente y los access tokens de esa sesión también quedan inservibles
      await refreshWith(ctx, legitToken).expect(401);
      await me(legit.body.accessToken).expect(401);
      await me(accessToken).expect(401);

      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'REFRESH_REUSE_DETECTED', userId: user.id } });
      expect(log).toMatchObject({ entityId: sessionId });
      expect(log!.ip).toBeTruthy();
      expect(JSON.stringify(log)).not.toContain(stolen);
      expect(JSON.stringify(log)).not.toContain(sha(stolen));
    });

    it('la reutilización solo afecta a esa sesión: las demás sesiones del usuario siguen vivas', async () => {
      const user = await fx.user();
      const compromised = await loginFull(ctx, user.email);
      const other = await loginFull(ctx, user.email);
      await refreshWith(ctx, compromised.refreshToken).expect(200);
      await refreshWith(ctx, compromised.refreshToken).expect(401);
      await me(other.accessToken).expect(200);
      await refreshWith(ctx, other.refreshToken).expect(200);
    });

    it('dos renovaciones simultáneas con el mismo token: solo una gana y la sesión se revoca (modo estricto)', async () => {
      const user = await fx.user();
      const { refreshToken, accessToken } = await loginFull(ctx, user.email);
      const results = await Promise.all([refreshWith(ctx, refreshToken), refreshWith(ctx, refreshToken)]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 401]);
      expect((await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(accessToken) } })).revokedReason).toBe('REUSE_DETECTED');
    });
  });

  describe('vencimiento y estado del usuario', () => {
    it('un refresh token vencido por inactividad se rechaza y cierra la sesión', async () => {
      const user = await fx.user();
      const { refreshToken, accessToken } = await loginFull(ctx, user.email);
      await ctx.db.refreshToken.updateMany({ where: { tokenHash: sha(refreshToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await refreshWith(ctx, refreshToken).expect(401);
      expect(setCookies(res).some((c) => c.startsWith(`${COOKIE_NAME}=;`))).toBe(true);
      expect((await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(accessToken) } })).revokedReason).toBe('EXPIRED');
    });

    it('el tope absoluto de la sesión se respeta aunque el refresh token siga vigente', async () => {
      const user = await fx.user();
      const { refreshToken, accessToken } = await loginFull(ctx, user.email);
      await ctx.db.authSession.update({ where: { id: sessionIdOf(accessToken) }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
      await refreshWith(ctx, refreshToken).expect(401);
      await me(accessToken).expect(401); // el access token también depende de la sesión
    });

    it('el refresh token nunca vive más que el tope absoluto de la sesión', async () => {
      const user = await fx.user();
      const { refreshToken, accessToken } = await loginFull(ctx, user.email);
      const session = await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(accessToken) } });
      await ctx.db.authSession.update({ where: { id: session.id }, data: { absoluteExpiresAt: new Date(Date.now() + 600_000) } });
      const res = await refreshWith(ctx, refreshToken).expect(200);
      const next = await ctx.db.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha(refreshTokenFrom(res)!) } });
      expect(next.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
    });

    it('un usuario deshabilitado no puede renovar y su sesión se cierra', async () => {
      const user = await fx.user();
      const { refreshToken, accessToken } = await loginFull(ctx, user.email);
      await ctx.db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
      await refreshWith(ctx, refreshToken).expect(401);
      await me(accessToken).expect(401);
      expect((await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(accessToken) } })).revokedReason).toBe('USER_DISABLED');
    });

    it('rechaza cookie ausente, vacía, basura o con otro formato, siempre con el mismo 401', async () => {
      const messages = new Set<string>();
      for (const value of [null, '', 'basura', 'rt_corto', `rt_${'A'.repeat(43)}`, 'rt_' + 'x'.repeat(200)]) {
        const res = await refreshWith(ctx, value === null ? null : value).expect(401);
        messages.add(res.body.message);
      }
      expect([...messages]).toEqual(['Sesión inválida o vencida']);
    });

    it('un token de refresh no sirve como access token ni al revés', async () => {
      const user = await fx.user();
      const { refreshToken, accessToken } = await loginFull(ctx, user.email);
      await me(refreshToken).expect(401);
      await refreshWith(ctx, accessToken).expect(401);
    });
  });

  describe('protección CSRF en refresh y logout', () => {
    it('rechaza sin Origen, con Origen no permitido, sin X-Requested-With, sin JSON o con Sec-Fetch-Site cross-site', async () => {
      const user = await fx.user();
      const { refreshToken } = await loginFull(ctx, user.email);
      const attempts: [string, Record<string, string>][] = [
        ['sin Origin', { 'X-Requested-With': 'ApiDental', 'Content-Type': 'application/json' }],
        ['Origin ajeno', { ...csrfHeaders, Origin: 'https://evil.example' }],
        ['Origin con subdominio parecido', { ...csrfHeaders, Origin: 'http://localhost:5173.evil.example' }],
        ['sin X-Requested-With', { Origin: ORIGIN, 'Content-Type': 'application/json' }],
        ['X-Requested-With incorrecto', { ...csrfHeaders, 'X-Requested-With': 'XMLHttpRequest' }],
        ['sin Content-Type JSON', { Origin: ORIGIN, 'X-Requested-With': 'ApiDental', 'Content-Type': 'text/plain' }],
        ['formulario clásico', { Origin: ORIGIN, 'X-Requested-With': 'ApiDental', 'Content-Type': 'application/x-www-form-urlencoded' }],
        ['Sec-Fetch-Site cross-site', { ...csrfHeaders, 'Sec-Fetch-Site': 'cross-site' }],
      ];
      for (const [label, headers] of attempts) {
        const res = await refreshWith(ctx, refreshToken, headers);
        expect(res.status, label).toBe(403);
        expect(res.body.message, label).toMatch(/CSRF/);
      }
      // ninguna de las solicitudes rechazadas consumió ni rotó el token
      expect((await refreshWith(ctx, refreshToken).expect(200)).status).toBe(200);
    });

    it('acepta same-origin y same-site', async () => {
      const user = await fx.user();
      let token = (await loginFull(ctx, user.email)).refreshToken;
      for (const site of ['same-origin', 'same-site']) {
        const res = await refreshWith(ctx, token, { ...csrfHeaders, 'Sec-Fetch-Site': site }).expect(200);
        token = refreshTokenFrom(res)!;
      }
    });

    it('logout y logout-all exigen las mismas barreras', async () => {
      const user = await fx.user();
      const { accessToken, refreshToken } = await loginFull(ctx, user.email);
      const bad = { 'X-Requested-With': 'ApiDental', 'Content-Type': 'application/json' }; // sin Origin
      await ctx.http().post('/v1/auth/logout').set(bad).set(bearer(accessToken)).set('Cookie', cookieHeader(refreshToken)).send({}).expect(403);
      await ctx.http().post('/v1/auth/logout-all').set(bad).set(bearer(accessToken)).send({}).expect(403);
      await me(accessToken).expect(200); // la sesión sigue viva
    });

    it('CORS permite credenciales solo al origen configurado', async () => {
      const ok = await ctx.http().options('/v1/auth/refresh').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-requested-with,content-type');
      expect(ok.status).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(ok.headers['access-control-allow-credentials']).toBe('true');
      expect(ok.headers['access-control-allow-headers']?.toLowerCase()).toContain('x-requested-with');
      for (const evil of ['https://evil.example', 'null', 'http://localhost:5174']) {
        const res = await ctx.http().options('/v1/auth/refresh').set('Origin', evil).set('Access-Control-Request-Method', 'POST');
        expect(res.headers['access-control-allow-origin'], evil).toBeUndefined();
        expect(res.headers['access-control-allow-credentials'], evil).toBeUndefined();
      }
      const simple = await ctx.http().get('/v1/health').set('Origin', 'https://evil.example');
      expect(simple.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('el resto de la API no usa cookies: un access token no viaja por cookie', async () => {
      const user = await fx.user();
      const { accessToken } = await loginFull(ctx, user.email);
      await ctx.http().get('/v1/auth/me').set('Cookie', `${COOKIE_NAME}=${accessToken}; access_token=${accessToken}`).expect(401);
    });
  });

  describe('logout', () => {
    it('cierra la sesión actual: el access token y el refresh token dejan de servir al instante', async () => {
      const user = await fx.user();
      const { accessToken, refreshToken } = await loginFull(ctx, user.email);
      await me(accessToken).expect(200);
      const res = await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set(bearer(accessToken)).set('Cookie', cookieHeader(refreshToken)).send({}).expect(204);
      expect(setCookies(res).some((c) => c.startsWith(`${COOKIE_NAME}=;`))).toBe(true);
      expect(res.text).toBe('');

      await me(accessToken).expect(401);
      await refreshWith(ctx, refreshToken).expect(401);
      const session = await ctx.db.authSession.findUniqueOrThrow({ where: { id: sessionIdOf(accessToken) } });
      expect(session.revokedReason).toBe('LOGOUT');
      expect(await ctx.db.refreshToken.count({ where: { sessionId: session.id, status: 'ACTIVE' } })).toBe(0);
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'SESSION_LOGOUT', userId: user.id } });
      expect(log).toMatchObject({ entityId: session.id });
      // un intento posterior de usar el token revocado NO se confunde con una reutilización
      expect(await ctx.db.auditLog.count({ where: { action: 'REFRESH_REUSE_DETECTED', userId: user.id } })).toBe(0);
    });

    it('funciona solo con la cookie (access token vencido o ausente)', async () => {
      const user = await fx.user();
      const { accessToken, refreshToken } = await loginFull(ctx, user.email);
      await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set('Cookie', cookieHeader(refreshToken)).send({}).expect(204);
      await me(accessToken).expect(401);
    });

    it('funciona solo con el access token (sin cookie)', async () => {
      const user = await fx.user();
      const { accessToken, refreshToken } = await loginFull(ctx, user.email);
      await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set(bearer(accessToken)).send({}).expect(204);
      await refreshWith(ctx, refreshToken).expect(401);
    });

    it('es idempotente y no revela nada: sin credenciales, con basura o repetido responde siempre 204', async () => {
      await ctx.http().post('/v1/auth/logout').set(csrfHeaders).send({}).expect(204);
      await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set('Cookie', cookieHeader('basura')).set('Authorization', 'Bearer x.y.z').send({}).expect(204);
      const user = await fx.user();
      const { accessToken, refreshToken } = await loginFull(ctx, user.email);
      for (let i = 0; i < 2; i++) {
        await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set(bearer(accessToken)).set('Cookie', cookieHeader(refreshToken)).send({}).expect(204);
      }
      expect(await ctx.db.auditLog.count({ where: { action: 'SESSION_LOGOUT', userId: user.id } })).toBe(1);
    });

    it('cerrar una sesión no afecta a las otras sesiones del mismo usuario', async () => {
      const user = await fx.user();
      const a = await loginFull(ctx, user.email);
      const b = await loginFull(ctx, user.email);
      await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set(bearer(a.accessToken)).set('Cookie', cookieHeader(a.refreshToken)).send({}).expect(204);
      await me(a.accessToken).expect(401);
      await me(b.accessToken).expect(200);
      await refreshWith(ctx, b.refreshToken).expect(200);
    });

    it('no se puede cerrar la sesión de otro usuario mezclando su cookie con el access token propio', async () => {
      const victim = await fx.user();
      const attacker = await fx.user();
      const v = await loginFull(ctx, victim.email);
      const a = await loginFull(ctx, attacker.email);
      await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set(bearer(a.accessToken)).set('Cookie', cookieHeader(v.refreshToken)).send({}).expect(204);
      await me(a.accessToken).expect(401); // cerró solo la propia
      await me(v.accessToken).expect(200); // la de la víctima intacta
    });
  });

  describe('logout global', () => {
    it('cierra todas las sesiones del usuario y solo las suyas', async () => {
      const user = await fx.user();
      const other = await fx.user();
      const s1 = await loginFull(ctx, user.email);
      const s2 = await loginFull(ctx, user.email);
      const s3 = await loginFull(ctx, user.email);
      const foreign = await loginFull(ctx, other.email);

      const res = await ctx.http().post('/v1/auth/logout-all').set(csrfHeaders).set(bearer(s1.accessToken)).send({}).expect(204);
      expect(setCookies(res).some((c) => c.startsWith(`${COOKIE_NAME}=;`))).toBe(true);
      for (const s of [s1, s2, s3]) {
        await me(s.accessToken).expect(401);
        await refreshWith(ctx, s.refreshToken).expect(401);
      }
      await me(foreign.accessToken).expect(200);
      expect(await ctx.db.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
      expect(await ctx.db.authSession.count({ where: { userId: user.id, revokedReason: 'LOGOUT_ALL' } })).toBe(3);
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'SESSION_LOGOUT_ALL', userId: user.id } });
      expect(log!.summary).toEqual({ sessionsRevoked: 3 });
    });

    it('exige autenticación', async () => {
      await ctx.http().post('/v1/auth/logout-all').set(csrfHeaders).send({}).expect(401);
    });

    it('después del logout global se puede volver a iniciar sesión normalmente', async () => {
      const user = await fx.user();
      const s = await loginFull(ctx, user.email);
      await ctx.http().post('/v1/auth/logout-all').set(csrfHeaders).set(bearer(s.accessToken)).send({}).expect(204);
      const again = await loginFull(ctx, user.email, PASSWORD);
      await me(again.accessToken).expect(200);
    });
  });

  it('un access token con el sid de la sesión de otro usuario no autentica', async () => {
    const a = await fx.user();
    const b = await fx.user();
    const sa = await loginFull(ctx, a.email);
    const sb = await loginFull(ctx, b.email);
    // misma firma válida pero sid cruzado: se fabrica con el servicio de tokens real
    const { TokenService } = await import('../src/auth/token.service.js');
    const forged = await ctx.app.get(TokenService).sign(a.id, sessionIdOf(sb.accessToken));
    await me(forged).expect(401);
    await me(sa.accessToken).expect(200);
  });
});
