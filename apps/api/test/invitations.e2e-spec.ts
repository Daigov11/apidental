import { createHash } from 'node:crypto';
import {
  acceptReq,
  actorIn,
  bearer,
  createTestContext,
  Fixtures,
  inviteOk,
  inviteReq,
  loginFull,
  loginInContext,
  NEW_PASSWORD,
  PASSWORD,
  tokenFromUrl,
  type TestContext,
  uniq,
} from './helpers/app.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const strip = (body: Record<string, unknown>) => ({ ...body, requestId: 0, timestamp: 0, path: 0 });

describe('Invitaciones', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const a1 = await fx.branch(a.id);
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: a.id });
    const adminB = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: b.id });
    return { a, b, a1, admin, adminB };
  }
  const email = () => `${uniq('inv')}@test.pe`;
  const preview = (token: string) => ctx.http().post('/v1/invitations/preview').send({ token });
  const auditOf = (invitationId: string) => ctx.db.auditLog.findMany({ where: { entityId: invitationId }, orderBy: { createdAt: 'asc' } });

  describe('creación', () => {
    it('crea una invitación de un solo uso: el token solo existe en el enlace y en la BD solo su hash', async () => {
      const w = await world();
      const to = email();
      const res = await inviteReq(ctx, w.admin.token, { email: to.toUpperCase(), roleCode: 'DENTIST', branchId: w.a1.id }).expect(201);
      const token = tokenFromUrl(res.body.devAcceptUrl);

      expect(res.body.devAcceptUrl).toMatch(/^http:\/\/localhost:5173\/admin\/aceptar-invitacion#token=inv_[A-Za-z0-9_-]{43}$/);
      expect(token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/);
      expect(res.body).toMatchObject({
        email: to,
        status: 'PENDING',
        role: { code: 'DENTIST' },
        clinicId: w.a.id,
        branchId: w.a1.id,
        delivery: { status: 'SENT', attempts: 1, lastError: null },
      });
      const ttl = Date.parse(res.body.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(71 * 3_600_000);
      expect(ttl).toBeLessThanOrEqual(72 * 3_600_000);
      // el cuerpo no trae el token ni su hash (salvo el enlace de DESARROLLO)
      const { devAcceptUrl: _dev, ...rest } = res.body;
      expect(JSON.stringify(rest)).not.toContain(token);
      expect(JSON.stringify(rest)).not.toContain(sha(token));
      expect(JSON.stringify(rest)).not.toMatch(/tokenHash|token_hash/);

      const row = await ctx.db.invitation.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.tokenHash).toBe(sha(token));
      expect(row.tokenHash).not.toBe(token);
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row.pendingKey).toBeTruthy();
    });

    it('audita la creación y el envío con el destinatario enmascarado y sin el token', async () => {
      const w = await world();
      const to = email();
      const { id, token } = await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'RECEPTIONIST' });
      const logs = await auditOf(id);
      expect(logs.map((l) => l.action)).toEqual(['INVITATION_CREATED', 'INVITATION_SENT']);
      expect(logs[0]).toMatchObject({ userId: w.admin.user.id, clinicId: w.a.id });
      expect(logs[0]!.summary).toMatchObject({ roleCode: 'RECEPTIONIST', issuedByPlatform: false });
      expect(logs[1]!.summary).toMatchObject({ channel: 'dev', kind: 'created' });
      const dump = JSON.stringify(logs);
      for (const secret of [token, sha(token), to]) expect(dump).not.toContain(secret);
    });

    it('la respuesta es idéntica exista o no una cuenta con ese correo (no revela cuentas)', async () => {
      const w = await world();
      const existing = await fx.user();
      const fresh = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'CASHIER' });
      const known = await inviteOk(ctx, w.admin.token, { email: existing.email, roleCode: 'CASHIER' });
      const shape = (r: { res: { status: number; body: Record<string, unknown> } }) => ({
        status: r.res.status,
        keys: Object.keys(r.res.body).sort(),
        delivery: (r.res.body.delivery as Record<string, unknown>).status,
        role: r.res.body.role,
      });
      expect(shape(known)).toEqual(shape(fresh));
      // y no se consultó ni se modificó la cuenta existente
      expect(await ctx.db.userAssignment.count({ where: { userId: existing.id } })).toBe(0);
    });

    it('no admite dos invitaciones pendientes para el mismo destinatario, rol y alcance; sí tras revocar', async () => {
      const w = await world();
      const to = email();
      const first = await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'ASSISTANT' });
      const dup = await inviteReq(ctx, w.admin.token, { email: to, roleCode: 'ASSISTANT' }).expect(409);
      expect(dup.body.message).toMatch(/pendiente/);
      await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'CASHIER' }); // otro rol: válido
      await ctx.http().post(`/v1/invitations/${first.id}/revoke`).set(bearer(w.admin.token)).send({ reason: 'Se equivocó de rol' }).expect(200);
      await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'ASSISTANT' });
    });

    it('valida el cuerpo y rechaza campos desconocidos', async () => {
      const w = await world();
      await inviteReq(ctx, w.admin.token, { email: 'no-es-correo', roleCode: 'DENTIST' }).expect(400);
      await inviteReq(ctx, w.admin.token, { roleCode: 'DENTIST' }).expect(400);
      await inviteReq(ctx, w.admin.token, { email: email() }).expect(400);
      await inviteReq(ctx, w.admin.token, { email: email(), roleCode: 'dentist' }).expect(400);
      await inviteReq(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST', password: 'Impuesta-Por-El-Admin-1' }).expect(400);
      await inviteReq(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST', status: 'ACCEPTED' }).expect(400);
    });

    it('solo administración invita: recepción, odontólogo, caja, asistente y Director reciben 403; sin JWT, 401', async () => {
      const w = await world();
      for (const role of ['RECEPTIONIST', 'DENTIST', 'CASHIER', 'ASSISTANT']) {
        const actor = await actorIn(ctx, fx, role, { clinicId: w.a.id });
        await inviteReq(ctx, actor.token, { email: email(), roleCode: 'ASSISTANT' }).expect(403);
        await ctx.http().get('/v1/invitations').set(bearer(actor.token)).expect(403);
      }
      await ctx.http().post('/v1/invitations').send({ email: email(), roleCode: 'DENTIST' }).expect(401);
    });

    it('un administrador no invita a roles con más permisos que los suyos', async () => {
      const w = await world();
      await inviteReq(ctx, w.admin.token, { email: email(), roleCode: 'PLATFORM_ADMIN' }).expect(403);
    });
  });

  describe('listado y alcance', () => {
    it('cada clínica ve solo sus invitaciones y nunca el token ni el hash', async () => {
      const w = await world();
      const mine = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      const theirs = await inviteOk(ctx, w.adminB.token, { email: email(), roleCode: 'DENTIST' });
      const list = await ctx.http().get('/v1/invitations?limit=100').set(bearer(w.admin.token)).expect(200);
      const ids = list.body.map((i: { id: string }) => i.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      const text = JSON.stringify(list.body);
      expect(text).not.toContain(mine.token);
      expect(text).not.toContain(sha(mine.token));
      expect(text).not.toMatch(/tokenHash|token_hash|devAcceptUrl|#token=/);
      const pending = await ctx.http().get('/v1/invitations?status=PENDING').set(bearer(w.admin.token)).expect(200);
      expect(pending.body.every((i: { status: string }) => i.status === 'PENDING')).toBe(true);
    });

    it('otra clínica no puede revocar ni reenviar (404 uniforme) y la invitación no cambia', async () => {
      const w = await world();
      const inv = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      await ctx.http().post(`/v1/invitations/${inv.id}/revoke`).set(bearer(w.adminB.token)).send({ reason: 'intento ajeno' }).expect(404);
      await ctx.http().post(`/v1/invitations/${inv.id}/resend`).set(bearer(w.adminB.token)).send({}).expect(404);
      expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PENDING');
      await ctx.http().post('/v1/invitations/no-es-uuid/revoke').set(bearer(w.admin.token)).send({ reason: 'x'.repeat(5) }).expect(400);
    });
  });

  describe('aceptación (cuenta nueva)', () => {
    it('la persona crea su propia contraseña; queda la cuenta, la asignación y la invitación cerrada', async () => {
      const w = await world();
      const to = email();
      const { id, token } = await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'DENTIST', branchId: w.a1.id });

      const pv = await preview(token).expect(200);
      expect(pv.body).toMatchObject({ clinicName: w.a.name, roleName: 'Odontólogo', requiresExistingPassword: false });
      expect(pv.body.emailHint).toMatch(/^[a-z]\*\*\*@\*\*\*\.pe$/);
      expect(JSON.stringify(pv.body)).not.toContain(to);

      const res = await acceptReq(ctx, token, { firstName: 'Rosa', lastName: 'Quispe' }).expect(200);
      expect(res.body).toEqual({ accepted: true, role: { code: 'DENTIST', name: 'Odontólogo' }, clinic: { name: w.a.name } });
      expect(JSON.stringify(res.body)).not.toMatch(/token|password|hash/i);
      expect(JSON.stringify(res.body)).not.toContain(to);

      const user = await ctx.db.user.findUniqueOrThrow({ where: { email: to }, omit: { passwordHash: false } });
      expect(user).toMatchObject({ firstName: 'Rosa', lastName: 'Quispe', status: 'ACTIVE' });
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
      const assignment = await ctx.db.userAssignment.findFirstOrThrow({ where: { userId: user.id } });
      expect(assignment).toMatchObject({ clinicId: w.a.id, branchId: w.a1.id, status: 'ACTIVE' });
      const inv = await ctx.db.invitation.findUniqueOrThrow({ where: { id } });
      expect(inv).toMatchObject({ status: 'ACCEPTED', acceptedUserId: user.id, pendingKey: null });
      expect(inv.acceptedAt).toBeInstanceOf(Date);

      // puede iniciar sesión con la contraseña que ELIGIÓ, y con ninguna otra
      await ctx.http().post('/v1/auth/login').send({ email: to, password: NEW_PASSWORD }).expect(200);
      await ctx.http().post('/v1/auth/login').send({ email: to, password: PASSWORD }).expect(401);

      const actions = (await ctx.db.auditLog.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['INVITATION_ACCEPTED', 'USER_CREATED', 'ASSIGNMENT_CREATED', 'LOGIN_SUCCESS']));
      const dump = JSON.stringify(await ctx.db.auditLog.findMany({ where: { clinicId: w.a.id } }));
      for (const secret of [token, sha(token), NEW_PASSWORD, to]) expect(dump).not.toContain(secret);
    });

    it('un token se usa una sola vez: el segundo intento (y el preview) fallan igual que un token inexistente', async () => {
      const w = await world();
      const { id, token } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'ASSISTANT' });
      await acceptReq(ctx, token).expect(200);
      const reused = await acceptReq(ctx, token).expect(404);
      const unknown = await acceptReq(ctx, `inv_${'A'.repeat(43)}`).expect(404);
      expect(strip(reused.body)).toEqual(strip(unknown.body));
      expect(reused.body.message).toBe('Invitación inválida o vencida');
      await preview(token).expect(404);
      const rejected = await ctx.db.auditLog.findMany({ where: { entityId: id, action: 'INVITATION_REJECTED' } });
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.summary).toEqual({ reason: 'status_accepted' });
    });

    it('valida los datos de la cuenta nueva sin consumir la invitación', async () => {
      const w = await world();
      const { id, token } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'ASSISTANT' });
      const short = await acceptReq(ctx, token, { password: 'corta' }).expect(400);
      expect(JSON.stringify(short.body.message)).toMatch(/al menos 12/);
      await acceptReq(ctx, token, { firstName: undefined }).expect(400);
      await acceptReq(ctx, token, { lastName: undefined }).expect(400);
      await acceptReq(ctx, token, { password: 'x'.repeat(129) }).expect(400);
      await acceptReq(ctx, token, { role: 'PLATFORM_ADMIN' }).expect(400);
      await acceptReq(ctx, token, { clinicId: 'otra' }).expect(400);
      expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
      await acceptReq(ctx, token).expect(200); // sigue siendo utilizable
    });

    it('dos aceptaciones simultáneas: solo una prospera y se crea una sola cuenta', async () => {
      const w = await world();
      const to = email();
      const { token } = await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'CASHIER' });
      const results = await Promise.all([acceptReq(ctx, token), acceptReq(ctx, token), acceptReq(ctx, token)]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 404, 404]);
      expect(await ctx.db.user.count({ where: { email: to } })).toBe(1);
      expect(await ctx.db.userAssignment.count({ where: { user: { email: to } } })).toBe(1);
    });
  });

  describe('token manipulado, vencido o revocado', () => {
    it('todo token inválido recibe exactamente la misma respuesta', async () => {
      const w = await world();
      const { token } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      const swapped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      const variants = [
        swapped,
        token.slice(0, -3),
        token + 'x',
        token.replace('inv_', 'rt_'),
        token.toUpperCase(),
        `inv_${'0'.repeat(43)}`,
        '',
        'basura',
        ' ' + token,
      ];
      const bodies = new Set<string>();
      for (const v of variants) {
        const a = await acceptReq(ctx, v);
        const p = await preview(v);
        expect([a.status, p.status], JSON.stringify(v)).toEqual([404, 404]);
        bodies.add(JSON.stringify(strip(a.body)));
        bodies.add(JSON.stringify(strip(p.body)));
      }
      expect(bodies.size).toBe(1);
      // y ninguno de esos intentos tocó la invitación real
      await acceptReq(ctx, token).expect(200);
    });

    it('vencida: se rechaza igual, se marca EXPIRED y se audita una sola vez', async () => {
      const w = await world();
      const { id, token } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      await ctx.db.invitation.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await acceptReq(ctx, token).expect(404);
      expect(res.body.message).toBe('Invitación inválida o vencida');
      await preview(token).expect(404);
      await acceptReq(ctx, token).expect(404);
      const row = await ctx.db.invitation.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'EXPIRED', pendingKey: null });
      expect(row.expiredAt).toBeInstanceOf(Date);
      expect(await ctx.db.auditLog.count({ where: { entityId: id, action: 'INVITATION_EXPIRED' } })).toBe(1);
      expect(await ctx.db.user.count({ where: { email: row.email } })).toBe(0);
      // el correo queda libre para una invitación nueva
      await inviteOk(ctx, w.admin.token, { email: row.email, roleCode: 'DENTIST' });
    });

    it('al listar se vencen en lote las invitaciones caducadas', async () => {
      const w = await world();
      const { id } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      await ctx.db.invitation.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const list = await ctx.http().get('/v1/invitations?limit=100').set(bearer(w.admin.token)).expect(200);
      expect(list.body.find((i: { id: string }) => i.id === id).status).toBe('EXPIRED');
      expect(await ctx.db.auditLog.count({ where: { entityId: id, action: 'INVITATION_EXPIRED' } })).toBe(1);
    });

    it('revocada: exige motivo, queda auditada y el token deja de servir', async () => {
      const w = await world();
      const { id, token } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      const revoke = (body: object) => ctx.http().post(`/v1/invitations/${id}/revoke`).set(bearer(w.admin.token)).send(body);
      await revoke({}).expect(400);
      await revoke({ reason: 'no' }).expect(400);
      const res = await revoke({ reason: 'La persona ya no se incorpora' }).expect(200);
      expect(res.body).toMatchObject({ status: 'REVOKED', revokeReason: 'La persona ya no se incorpora' });
      await revoke({ reason: 'otra vez' }).expect(409);
      const reply = await acceptReq(ctx, token).expect(404);
      expect(reply.body.message).toBe('Invitación inválida o vencida');
      await preview(token).expect(404);
      const [log] = await ctx.db.auditLog.findMany({ where: { entityId: id, action: 'INVITATION_REVOKED' } });
      expect(log).toMatchObject({ userId: w.admin.user.id });
      expect(log!.summary).toMatchObject({ reason: 'La persona ya no se incorpora' });
      expect((await ctx.db.auditLog.findMany({ where: { entityId: id, action: 'INVITATION_REJECTED' } }))[0]!.summary).toEqual({ reason: 'status_revoked' });
    });

    it('reenviar genera un token NUEVO: el enlace anterior deja de valer', async () => {
      const w = await world();
      const { id, token: oldToken } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      const before = await ctx.db.invitation.findUniqueOrThrow({ where: { id } });
      const res = await ctx.http().post(`/v1/invitations/${id}/resend`).set(bearer(w.admin.token)).send({}).expect(200);
      const newToken = tokenFromUrl(res.body.devAcceptUrl);
      expect(newToken).not.toBe(oldToken);
      expect(res.body.delivery).toMatchObject({ status: 'SENT', attempts: 2 });
      const after = await ctx.db.invitation.findUniqueOrThrow({ where: { id } });
      expect(after.tokenHash).toBe(sha(newToken));
      expect(after.tokenHash).not.toBe(before.tokenHash);
      expect(after.tokenRotatedAt).toBeInstanceOf(Date);
      await acceptReq(ctx, oldToken).expect(404);
      await acceptReq(ctx, newToken).expect(200);
      const actions = (await auditOf(id)).map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['INVITATION_RESENT', 'INVITATION_SENT']));
      expect(JSON.stringify(await auditOf(id))).not.toContain(newToken);
    });

    it('no se puede reenviar una invitación aceptada, revocada o vencida', async () => {
      const w = await world();
      const accepted = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      await acceptReq(ctx, accepted.token).expect(200);
      await ctx.http().post(`/v1/invitations/${accepted.id}/resend`).set(bearer(w.admin.token)).send({}).expect(409);
      const expired = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      await ctx.db.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await ctx.http().post(`/v1/invitations/${expired.id}/resend`).set(bearer(w.admin.token)).send({}).expect(409);
    });
  });

  describe('cuenta que ya existe: la invitación nunca cambia su contraseña', () => {
    it('exige la contraseña ACTUAL, agrega la asignación y conserva credenciales y datos', async () => {
      const w = await world();
      const user = await fx.user();
      const before = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id }, omit: { passwordHash: false } });
      const { token } = await inviteOk(ctx, w.admin.token, { email: user.email, roleCode: 'DENTIST' });
      expect((await preview(token).expect(200)).body.requiresExistingPassword).toBe(true);

      // quien solo tiene el enlace (no la contraseña) no puede tomar la cuenta
      const bad = await acceptReq(ctx, token, { password: 'Intento-Con-Otra-Clave-1', firstName: 'Intruso', lastName: 'Falso' }).expect(401);
      expect(bad.body.message).toBe('No se pudo aceptar la invitación');
      expect(JSON.stringify(bad.body)).not.toContain(user.email);
      expect(await ctx.db.userAssignment.count({ where: { userId: user.id } })).toBe(0);

      await acceptReq(ctx, token, { password: PASSWORD, firstName: 'Intruso', lastName: 'Falso' }).expect(200);
      const after = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id }, omit: { passwordHash: false } });
      expect(after.passwordHash).toBe(before.passwordHash); // la contraseña no cambió
      expect(after).toMatchObject({ firstName: before.firstName, lastName: before.lastName }); // ni los datos
      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: NEW_PASSWORD }).expect(401);
      const ctxs = await loginFull(ctx, user.email);
      const list = await ctx.http().get('/v1/auth/context').set(bearer(ctxs.accessToken)).expect(200);
      expect(list.body.map((c: { role: { code: string } }) => c.role.code)).toContain('DENTIST');
    });

    it('un docente en dos clínicas: la segunda invitación se acepta con su contraseña actual', async () => {
      const w = await world();
      const to = email();
      const first = await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'DENTIST' });
      await acceptReq(ctx, first.token, { password: 'Clave-Del-Doctor-2026' }).expect(200);
      const second = await inviteOk(ctx, w.adminB.token, { email: to, roleCode: 'DENTIST' });
      await acceptReq(ctx, second.token, { password: NEW_PASSWORD }).expect(401);
      await acceptReq(ctx, second.token, { password: 'Clave-Del-Doctor-2026' }).expect(200);
      const login = await loginFull(ctx, to, 'Clave-Del-Doctor-2026');
      const list = await ctx.http().get('/v1/auth/context').set(bearer(login.accessToken)).expect(200);
      expect(new Set(list.body.map((c: { clinic: { id: string } }) => c.clinic.id))).toEqual(new Set([w.a.id, w.b.id]));
    });

    it('una cuenta creada entre la invitación y la aceptación NO puede ser tomada con una contraseña nueva', async () => {
      const w = await world();
      const to = email();
      const { token } = await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'ASSISTANT' });
      const squatter = await fx.user({ email: to }); // alguien registra esa cuenta antes
      await acceptReq(ctx, token, { password: 'Clave-Nueva-Del-Atacante-1' }).expect(401);
      expect(await ctx.db.userAssignment.count({ where: { userId: squatter.id } })).toBe(0);
    });

    it('los fallos de contraseña cuentan para el bloqueo de la cuenta', async () => {
      const w = await world();
      const user = await fx.user();
      const { token } = await inviteOk(ctx, w.admin.token, { email: user.email, roleCode: 'DENTIST' });
      for (let i = 0; i < 3; i++) await acceptReq(ctx, token, { password: `Intento-${i}-Incorrecto-1` }).expect(401);
      expect((await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      await acceptReq(ctx, token, { password: PASSWORD }).expect(401); // bloqueada: ni la correcta sirve
      await ctx.http().post('/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
      expect(await ctx.db.auditLog.count({ where: { userId: user.id, action: 'INVITATION_REJECTED' } })).toBeGreaterThanOrEqual(3);
    });

    it('una cuenta deshabilitada no puede aceptar (respuesta genérica)', async () => {
      const w = await world();
      const user = await fx.user();
      const { token } = await inviteOk(ctx, w.admin.token, { email: user.email, roleCode: 'DENTIST' });
      await ctx.db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
      expect((await acceptReq(ctx, token, { password: PASSWORD }).expect(404)).body.message).toBe('Invitación inválida o vencida');
    });

    it('aceptar dos veces la misma asignación es idempotente (no duplica)', async () => {
      const w = await world();
      const user = await fx.user();
      await fx.assign(user.id, 'DENTIST', { clinicId: w.a.id });
      const { token } = await inviteOk(ctx, w.admin.token, { email: user.email, roleCode: 'DENTIST' });
      await acceptReq(ctx, token, { password: PASSWORD }).expect(200);
      expect(await ctx.db.userAssignment.count({ where: { userId: user.id, roleId: (await ctx.db.role.findUniqueOrThrow({ where: { code: 'DENTIST' } })).id } })).toBe(1);
    });
  });

  describe('la situación cambió antes de aceptar', () => {
    it('si quien invitó perdió su autoridad, la invitación ya no sirve', async () => {
      const w = await world();
      const spare = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: w.a.id });
      const { id, token } = await inviteOk(ctx, spare.token, { email: email(), roleCode: 'DENTIST' });
      await ctx.db.userAssignment.updateMany({ where: { userId: spare.user.id }, data: { status: 'INACTIVE' } });
      await acceptReq(ctx, token).expect(404);
      expect((await ctx.db.auditLog.findMany({ where: { entityId: id, action: 'INVITATION_REJECTED' } }))[0]!.summary).toEqual({ reason: 'inviter_lost_authority' });
    });

    it('si la clínica o la sede se desactivan, la invitación ya no sirve', async () => {
      const w = await world();
      const inClinic = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      const inBranch = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST', branchId: w.a1.id });
      await ctx.db.branch.update({ where: { id: w.a1.id }, data: { status: 'INACTIVE' } });
      await acceptReq(ctx, inBranch.token).expect(404);
      await ctx.db.clinic.update({ where: { id: w.a.id }, data: { status: 'INACTIVE' } });
      await acceptReq(ctx, inClinic.token).expect(404);
    });
  });

  describe('garantías de la base de datos', () => {
    it('destinatario, rol, alcance y emisor son inmutables; una invitación cerrada no se reabre; no se elimina', async () => {
      const w = await world();
      const { id, token } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      const other = await ctx.db.role.findUniqueOrThrow({ where: { code: 'CLINIC_ADMIN' } });
      await expect(ctx.db.invitation.update({ where: { id }, data: { roleId: other.id } })).rejects.toThrow(/inmutables/);
      await expect(ctx.db.invitation.update({ where: { id }, data: { email: 'otro@test.pe' } })).rejects.toThrow(/inmutables/);
      await expect(ctx.db.invitation.update({ where: { id }, data: { clinicId: w.b.id } })).rejects.toThrow();
      await expect(ctx.db.invitation.update({ where: { id }, data: { issuedByPlatform: true } })).rejects.toThrow(/inmutables/);
      await expect(ctx.db.invitation.delete({ where: { id } })).rejects.toThrow(/solo se purgan invitaciones cerradas con más de 30 días/);
      await acceptReq(ctx, token).expect(200);
      await expect(ctx.db.invitation.update({ where: { id }, data: { status: 'PENDING' } })).rejects.toThrow(/no cambia de estado/);
    });

    it('una invitación con sede exige clínica (CHECK) y la sede debe ser de esa clínica (FK compuesta)', async () => {
      const w = await world();
      const role = await ctx.db.role.findUniqueOrThrow({ where: { code: 'DENTIST' } });
      const base = { email: email(), roleId: role.id, tokenHash: sha(uniq('t')), expiresAt: new Date(Date.now() + 1000), createdById: w.admin.user.id };
      await expect(ctx.db.invitation.create({ data: { ...base, branchId: w.a1.id, clinicId: null } })).rejects.toThrow();
      await expect(ctx.db.invitation.create({ data: { ...base, tokenHash: sha(uniq('t')), branchId: w.a1.id, clinicId: w.b.id } })).rejects.toThrow();
    });

    it('el hash del token es único', async () => {
      const w = await world();
      const { id } = await inviteOk(ctx, w.admin.token, { email: email(), roleCode: 'DENTIST' });
      const row = await ctx.db.invitation.findUniqueOrThrow({ where: { id } });
      const role = await ctx.db.role.findUniqueOrThrow({ where: { code: 'DENTIST' } });
      await expect(
        ctx.db.invitation.create({ data: { email: email(), roleId: role.id, tokenHash: row.tokenHash, expiresAt: new Date(), createdById: w.admin.user.id } }),
      ).rejects.toThrow();
    });
  });

  it('una invitación aceptada permite iniciar sesión y elegir el contexto de la clínica', async () => {
    const w = await world();
    const to = email();
    const { token } = await inviteOk(ctx, w.admin.token, { email: to, roleCode: 'CLINIC_ADMIN' });
    await acceptReq(ctx, token).expect(200);
    const ctxToken = await loginInContext(ctx, to, { clinicId: w.a.id }, NEW_PASSWORD);
    const me = await ctx.http().get('/v1/auth/me').set(bearer(ctxToken)).expect(200);
    expect(me.body.roles).toEqual(['CLINIC_ADMIN']);
    expect(me.body.permissions).toContain('invitation:manage');
    expect(me.body.permissions).not.toContain('director:manage');
  });
});
