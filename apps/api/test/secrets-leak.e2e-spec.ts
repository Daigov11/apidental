import { createHash } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import {
  acceptReq,
  actorIn,
  bearer,
  COOKIE_NAME,
  cookieHeader,
  createTestContext,
  csrfHeaders,
  Fixtures,
  inviteOk,
  inviteReq,
  confirmRecovery,
  devOutbox,
  loginFull,
  recoveryReq,
  requestRecovery,
  settleRecoveries,
  validateRecovery,
  NEW_PASSWORD,
  PASSWORD,
  reauthProofFor,
  refreshTokenFrom,
  refreshWith,
  tokenFromUrl,
  type TestContext,
  uniq,
  yearsAgo,
} from './helpers/app.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** Logger que CAPTURA todo lo que la aplicación escriba (todos los niveles). */
class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push(level: string, message: unknown, params: unknown[]) {
    const safe = (v: unknown) => {
      try {
        return typeof v === 'string' ? v : JSON.stringify(v);
      } catch {
        return String(v);
      }
    };
    this.lines.push(`${level} ${[message, ...params].map(safe).join(' ')}`);
  }
  log(m: unknown, ...p: unknown[]) { this.push('log', m, p); }
  error(m: unknown, ...p: unknown[]) { this.push('error', m, p); }
  warn(m: unknown, ...p: unknown[]) { this.push('warn', m, p); }
  debug(m: unknown, ...p: unknown[]) { this.push('debug', m, p); }
  verbose(m: unknown, ...p: unknown[]) { this.push('verbose', m, p); }
  fatal(m: unknown, ...p: unknown[]) { this.push('fatal', m, p); }
}

// Cualquier cosa con forma de token propio o de JWT es un secreto, aunque no conozcamos su valor.
const TOKEN_SHAPE = /\b(?:inv|rt|rp|pr)_[A-Za-z0-9_-]{43}\b/;
// Un SHA-256 en hexadecimal: en este recorrido NADA legítimo tiene esa forma (los ids son UUID).
const HEX64 = /\b[0-9a-f]{64}\b/;
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/;

describe('Ningún token, hash ni contraseña se filtra a respuestas no autorizadas, logs ni auditoría', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  const logger = new CapturingLogger();
  beforeAll(async () => {
    ctx = await createTestContext({ logger });
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  it('recorrido completo: sesiones, reutilización, reautenticación, invitaciones, aprovisionamiento y ataques', async () => {
    const clinic = await fx.clinic();
    const other = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const adminOther = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: other.id });

    // Cada secreto pertenece a un TIPO, y cada tipo solo puede aparecer en las respuestas que lo EMITEN.
    // (Dos emisiones de un access token en el mismo segundo, misma sesión y contexto, dan el mismo JWT.)
    const EMITTERS: Record<string, string[]> = {
      access: ['login', 'select-context', 'refresh'],
      refresh: [], // el refresh token viaja SOLO por la cookie Set-Cookie: nunca en un cuerpo
      reauth: ['reauth'],
      invitation: ['invitacion-crear', 'invitacion-reenviar'], // el enlace de DESARROLLO (en producción, ninguna)
    };
    const secrets = new Set<string>(); // valores exactos y sus hashes
    const kindOf = new Map<string, string>();
    const bodies: { label: string; text: string }[] = [];
    const register = (value: string, kind: string) => {
      secrets.add(value);
      secrets.add(sha(value));
      kindOf.set(value, kind);
    };
    const note = (label: string, res: { text?: string; body?: unknown }) =>
      bodies.push({ label, text: (res.text ?? '') + JSON.stringify(res.body ?? {}) });

    // --- sesión: login, contexto, renovación ---
    const wrongPassword = 'Contrasena-Equivocada-98765';
    note('login-fallido', await ctx.http().post('/v1/auth/login').send({ email: admin.user.email, password: wrongPassword }).expect(401));
    const login = await loginFull(ctx, admin.user.email);
    register(login.accessToken, 'access');
    register(login.refreshToken, 'refresh');
    note('login', login.res);
    const sel = await ctx.http().post('/v1/auth/select-context').set(bearer(login.accessToken)).send({ clinicId: clinic.id }).expect(200);
    register(sel.body.accessToken, 'access');
    note('select-context', sel);
    const refreshed = await refreshWith(ctx, login.refreshToken).expect(200);
    const rt2 = refreshTokenFrom(refreshed)!;
    register(refreshed.body.accessToken, 'access');
    register(rt2, 'refresh');
    note('refresh', refreshed);
    // un atacante reutiliza el token viejo: se detecta y la sesión se revoca
    note('refresh-reutilizado', await refreshWith(ctx, login.refreshToken).expect(401));
    note('refresh-sin-cookie', await refreshWith(ctx, null).expect(401));
    note('refresh-csrf', await refreshWith(ctx, rt2, { 'X-Requested-With': 'ApiDental', 'Content-Type': 'application/json' }).expect(403));

    // --- nueva sesión para el resto del recorrido ---
    const s2 = await loginFull(ctx, admin.user.email);
    register(s2.accessToken, 'access');
    register(s2.refreshToken, 'refresh');
    const sel2 = await ctx.http().post('/v1/auth/select-context').set(bearer(s2.accessToken)).send({ clinicId: clinic.id }).expect(200);
    const access = sel2.body.accessToken as string;
    register(access, 'access');
    note('me', await ctx.http().get('/v1/auth/me').set(bearer(access)).expect(200));
    note('contextos', await ctx.http().get('/v1/auth/context').set(bearer(access)).expect(200));

    // --- reautenticación ---
    note('reauth-fallida', await ctx.http().post('/v1/auth/reauthenticate').set(bearer(access)).send({ password: wrongPassword, purpose: 'CLOSE_CLINICAL_NOTE' }).expect(401));
    const proofRes = await ctx.http().post('/v1/auth/reauthenticate').set(bearer(access)).send({ password: PASSWORD, purpose: 'AUTHORIZE_DIRECTOR_PROVISIONING', targetId: clinic.id }).expect(200);
    register(proofRes.body.reauthToken, 'reauth');
    note('reauth', proofRes);

    // --- invitaciones ---
    const to = `${uniq('leak')}@test.pe`;
    const inv = await inviteReq(ctx, access, { email: to, roleCode: 'DENTIST' }).expect(201);
    const t1 = tokenFromUrl(inv.body.devAcceptUrl);
    register(t1, 'invitation');
    note('invitacion-crear', inv);
    note('invitacion-listar', await ctx.http().get('/v1/invitations?limit=100').set(bearer(access)).expect(200));
    note('invitacion-duplicada', await inviteReq(ctx, access, { email: to, roleCode: 'DENTIST' }).expect(409));
    const resent = await ctx.http().post(`/v1/invitations/${inv.body.id}/resend`).set(bearer(access)).send({}).expect(200);
    const t2 = tokenFromUrl(resent.body.devAcceptUrl);
    register(t2, 'invitation');
    note('invitacion-reenviar', resent);
    note('invitacion-token-viejo', await acceptReq(ctx, t1).expect(404));
    note('invitacion-preview', await ctx.http().post('/v1/invitations/preview').send({ token: t2 }).expect(200));
    note('invitacion-contrasena-corta', await acceptReq(ctx, t2, { password: 'corta' }).expect(400));
    note('invitacion-token-basura', await acceptReq(ctx, `${t2}${'z'.repeat(60)}`));
    note('invitacion-aceptar', await acceptReq(ctx, t2).expect(200));
    note('invitacion-reutilizar', await acceptReq(ctx, t2).expect(404));

    // --- aprovisionamiento formal del Director ---
    const recBody = {
      designeeName: 'Dra. Rosa Medina',
      designeeEmail: `${uniq('dir')}@test.pe`,
      authorizedByName: 'Luis Gómez',
      authorizedByPosition: 'Gerente general',
      authorizedByDocumentType: 'DNI',
      authorizedByDocumentNumber: '12345678',
      authorizationReference: 'Acta 7-2026',
      authorizationDate: yearsAgo(0, 2),
    };
    const rec = await ctx.http().post('/v1/provisioning-records').set(bearer(access)).send({ ...recBody, reauthToken: proofRes.body.reauthToken }).expect(201);
    note('provisioning', rec);
    const proof2 = await reauthProofFor(ctx, access, 'AUTHORIZE_DIRECTOR_PROVISIONING', clinic.id);
    register(proof2, 'reauth');
    const dir = await inviteOk(ctx, access, { email: recBody.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.body.id, reauthToken: proof2 });
    register(dir.token, 'invitation');
    note('provisioning-listar', await ctx.http().get('/v1/provisioning-records').set(bearer(access)).expect(200));
    await acceptReq(ctx, dir.token, { password: NEW_PASSWORD }).expect(200);

    // --- ataques entre clínicas y a sesiones ---
    note('otra-clinica-revocar', await ctx.http().post(`/v1/invitations/${inv.body.id}/revoke`).set(bearer(adminOther.token)).send({ reason: 'intento ajeno' }).expect(404));
    note('otra-clinica-listar', await ctx.http().get('/v1/invitations').set(bearer(adminOther.token)).expect(200));
    note('auditoria', await ctx.http().get('/v1/audit-logs?limit=100').set(bearer(access)).expect(200));

    // --- cierre de sesión ---
    await ctx.http().post('/v1/auth/logout').set(csrfHeaders).set(bearer(access)).set('Cookie', cookieHeader(s2.refreshToken)).send('{}').expect(204);
    const s3 = await loginFull(ctx, admin.user.email);
    await ctx.http().post('/v1/auth/logout-all').set(csrfHeaders).set(bearer(s3.accessToken)).send('{}').expect(204);

    // =================== VERIFICACIONES ===================
    // 1) Cada secreto aparece SOLO en las respuestas que lo emiten (y el refresh token en ninguna).
    for (const [value, kind] of kindOf) {
      for (const b of bodies) {
        if (!b.text.includes(value)) continue;
        expect(EMITTERS[kind]!.includes(b.label), `un secreto de tipo "${kind}" apareció en la respuesta "${b.label}"`).toBe(true);
      }
    }

    // 1b) Los HASHES de los tokens no salen jamás en ninguna respuesta, ni siquiera en las que emiten el token.
    for (const value of kindOf.keys()) for (const b of bodies) expect(b.text, `hash de un token en "${b.label}"`).not.toContain(sha(value));
    for (const b of bodies) expect(HEX64.test(b.text), `cadena de 64 hex (¿hash?) en "${b.label}"`).toBe(false);

    // 2) Las respuestas de error, listados y consultas no contienen NINGÚN token con forma de token ni JWT.
    for (const b of bodies.filter((x) => !['login', 'select-context', 'refresh', 'reauth', 'invitacion-crear', 'invitacion-reenviar'].includes(x.label))) {
      expect(TOKEN_SHAPE.test(b.text), `token en "${b.label}"`).toBe(false);
      expect(JWT_SHAPE.test(b.text), `JWT en "${b.label}"`).toBe(false);
    }

    // 3) Los LOGS no contienen secretos, contraseñas ni nada con forma de token.
    const logs = logger.lines.join('\n');
    expect(logs.length).toBeGreaterThan(0); // la captura funciona
    for (const secret of [...secrets, wrongPassword, PASSWORD, NEW_PASSWORD]) expect(logs).not.toContain(secret);
    expect(TOKEN_SHAPE.test(logs)).toBe(false);
    expect(HEX64.test(logs)).toBe(false);
    expect(JWT_SHAPE.test(logs)).toBe(false);
    expect(logs).not.toMatch(/Bearer\s+\S/i);
    expect(logs).not.toContain(COOKIE_NAME + '=');
    expect(logs).not.toMatch(/argon2/);

    // 4) La AUDITORÍA (toda la tabla de las clínicas del recorrido) no contiene secretos.
    const audit = JSON.stringify(await ctx.db.auditLog.findMany({ where: { OR: [{ clinicId: clinic.id }, { clinicId: other.id }, { userId: admin.user.id }] } }));
    for (const secret of [...secrets, wrongPassword, PASSWORD, NEW_PASSWORD, '12345678', recBody.designeeEmail, to]) expect(audit).not.toContain(secret);
    expect(TOKEN_SHAPE.test(audit)).toBe(false);
    expect(HEX64.test(audit)).toBe(false);
    expect(JWT_SHAPE.test(audit)).toBe(false);

    // 5) Las TABLAS solo guardan hashes: ningún token en claro (ni contraseña) en sesiones, pruebas ni invitaciones.
    const stored = JSON.stringify([
      await ctx.db.refreshToken.findMany({}),
      await ctx.db.reauthProof.findMany({}),
      await ctx.db.invitation.findMany({}),
      await ctx.db.authSession.findMany({}),
    ]);
    for (const [value, kind] of kindOf) expect(stored, `token en claro (${kind}) guardado en la BD`).not.toContain(value);
    expect(TOKEN_SHAPE.test(stored)).toBe(false);
    expect(stored).not.toContain(NEW_PASSWORD);
    // ...y sí guardan su hash
    expect(stored).toContain(sha(t2));
  });

  it('los mensajes de validación nunca repiten el valor enviado (token, contraseña o correo)', async () => {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const secretish = 'inv_' + 'Q'.repeat(43);
    const res = await ctx.http().post('/v1/invitations/accept').send({ token: secretish + 'x'.repeat(80), password: 'p'.repeat(200), extra: secretish });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(secretish);
    expect(res.text).not.toContain('ppppp');
    const bad = await inviteReq(ctx, admin.token, { email: 'correo-invalido-secreto', roleCode: 'DENTIST' });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain('correo-invalido-secreto');
  });
  it('la recuperación de contraseña no filtra tokens, hashes ni contraseñas a respuestas, logs, auditoría ni tablas', async () => {
    const user = await fx.user();
    const first = await requestRecovery(ctx, user.email);
    const unknown = `${uniq('nadie')}@test.pe`;
    const neutral = await recoveryReq(ctx, unknown).expect(202);
    const known = await recoveryReq(ctx, user.email).expect(202);
    await settleRecoveries(ctx);
    const token = tokenFromUrl(devOutbox(ctx).last('password_recovery', user.email.toLowerCase())!.url); // la nueva solicitud reemplaza a la anterior
    expect(token).not.toBe(first);
    expect(known.text).toBe(neutral.text);
    const nope = 'pr_' + 'Z'.repeat(43);
    const bad = await validateRecovery(ctx, nope);
    const badConfirm = await confirmRecovery(ctx, nope, 'Clave-Nueva-Segura-77');
    for (const r of [bad, badConfirm]) {
      expect(r.text).not.toContain(nope);
      expect(r.text).not.toContain('Clave-Nueva-Segura-77');
    }
    const newPassword = 'Clave-Definitiva-88-xy';
    await confirmRecovery(ctx, token, newPassword).expect(200);
    await confirmRecovery(ctx, token, newPassword).expect(404);

    const logs = logger.lines.join('\n');
    const audit = JSON.stringify(await ctx.db.auditLog.findMany({ where: { OR: [{ userId: user.id }, { entityId: user.id }] } }));
    const stored = JSON.stringify(await ctx.db.passwordRecovery.findMany({ where: { userId: user.id } }));
    for (const [name, text] of [['logs', logs], ['auditoría', audit], ['tabla', stored]] as const) {
      for (const secret of [token, nope, newPassword, 'Clave-Nueva-Segura-77']) expect(text, name).not.toContain(secret);
      expect(TOKEN_SHAPE.test(text), name).toBe(false);
      expect(JWT_SHAPE.test(text), name).toBe(false);
    }
    expect(logs).not.toContain(user.email);
    expect(audit).not.toContain(unknown);
    expect(stored).toContain(sha(token));
  });
});
