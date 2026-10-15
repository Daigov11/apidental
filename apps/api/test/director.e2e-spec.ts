import { randomUUID } from 'node:crypto';
import {
  acceptReq,
  actorIn,
  bearer,
  createTestContext,
  Fixtures,
  inviteOk,
  inviteReq,
  loginInContext,
  NEW_PASSWORD,
  reauthProofFor,
  type TestContext,
  uniq,
  yearsAgo,
} from './helpers/app.js';

describe('Aprovisionamiento formal y Director Clínico', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const PURPOSE = 'AUTHORIZE_DIRECTOR_PROVISIONING';

  async function world() {
    const clinic = await fx.clinic();
    const other = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const adminOther = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: other.id });
    const platform = await fx.userWithRole('PLATFORM_ADMIN');
    const platformToken = await loginInContext(ctx, platform.user.email);
    return { clinic, other, admin, adminOther, platformToken };
  }
  const designee = () => `${uniq('dir')}@test.pe`;
  const recordBody = (over: Record<string, unknown> = {}) => ({
    designeeName: 'Dra. Marta Quispe Rojas',
    designeeEmail: designee(),
    authorizedByName: 'Juan Pérez Soto',
    authorizedByPosition: 'Representante legal',
    authorizedByDocumentType: 'DNI',
    authorizedByDocumentNumber: '45678901',
    authorizationReference: 'Acta de directorio N.° 12-2026',
    authorizationDate: yearsAgo(0, 3),
    ...over,
  });
  const postRecord = (token: string, body: Record<string, unknown>) => ctx.http().post('/v1/provisioning-records').set(bearer(token)).send(body);
  async function record(w: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) {
    const body = recordBody(over);
    const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
    const res = await postRecord(w.admin.token, { ...body, reauthToken: proof }).expect(201);
    return { id: res.body.id as string, body, res };
  }
  /** Primer Director completo: registro → invitación → aceptación. */
  async function firstDirector(w: Awaited<ReturnType<typeof world>>) {
    const rec = await record(w);
    const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
    const inv = await inviteOk(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof });
    await acceptReq(ctx, inv.token, { firstName: 'Marta', lastName: 'Quispe' }).expect(200);
    const token = await loginInContext(ctx, rec.body.designeeEmail as string, { clinicId: w.clinic.id }, NEW_PASSWORD);
    return { rec, inv, token, email: rec.body.designeeEmail as string };
  }

  describe('registro formal de aprovisionamiento', () => {
    it('lo registra el administrador de la clínica con reautenticación; documento enmascarado y aviso de su alcance', async () => {
      const w = await world();
      const { res, body, id } = await record(w);
      expect(res.body).toMatchObject({
        kind: 'FIRST_CLINICAL_DIRECTOR',
        status: 'ACTIVE',
        designee: { name: body.designeeName, email: body.designeeEmail },
        authorizedBy: { name: body.authorizedByName, position: 'Representante legal', documentType: 'DNI', documentNumber: '*****901' },
        authorizationReference: body.authorizationReference,
        recordedById: w.admin.user.id,
      });
      expect(res.body.notice).toMatch(/no verifica la autenticidad del documento/);
      expect(JSON.stringify(res.body)).not.toContain('45678901');
      const days = (Date.parse(res.body.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThanOrEqual(30);

      // la prueba de reautenticación quedó gastada y se audita sin datos personales
      const proofs = await ctx.db.reauthProof.findMany({ where: { userId: w.admin.user.id, purpose: PURPOSE } });
      expect(proofs.every((p) => p.usedAt)).toBe(true);
      const logs = await ctx.db.auditLog.findMany({ where: { entityId: id } });
      expect(logs.map((l) => l.action)).toEqual(['PROVISIONING_RECORDED']);
      expect(logs[0]!.summary).toMatchObject({ kind: 'FIRST_CLINICAL_DIRECTOR', authorizerDocument: 'DNI *****901', selfDesignation: false });
      const dump = JSON.stringify(await ctx.db.auditLog.findMany({ where: { clinicId: w.clinic.id } }));
      for (const pii of [body.designeeName, body.designeeEmail, body.authorizedByName, '45678901'] as string[]) expect(dump).not.toContain(pii);
    });

    it('exige reautenticación válida: sin prueba, de otro propósito, de otro objeto o ya usada', async () => {
      const w = await world();
      await postRecord(w.admin.token, recordBody()).expect(400);
      const wrongPurpose = await reauthProofFor(ctx, w.admin.token, 'CLINICAL_READ_ALL', w.clinic.id);
      await postRecord(w.admin.token, { ...recordBody(), reauthToken: wrongPurpose }).expect(403);
      const wrongTarget = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.other.id);
      await postRecord(w.admin.token, { ...recordBody(), reauthToken: wrongTarget }).expect(403);
      const noTarget = await reauthProofFor(ctx, w.admin.token, PURPOSE);
      await postRecord(w.admin.token, { ...recordBody(), reauthToken: noTarget }).expect(403);
      await postRecord(w.admin.token, { ...recordBody(), reauthToken: 'rp_' + 'A'.repeat(43) }).expect(403);
      expect(await ctx.db.provisioningRecord.count({ where: { clinicId: w.clinic.id } })).toBe(0);

      const good = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      await postRecord(w.admin.token, { ...recordBody(), reauthToken: good }).expect(201);
      await postRecord(w.admin.token, { ...recordBody(), reauthToken: good }).expect(403); // ya usada
    });

    it('un fallo posterior no gasta la prueba (se consume dentro de la misma transacción)', async () => {
      const w = await world();
      await record(w);
      const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      await postRecord(w.admin.token, { ...recordBody(), reauthToken: proof }).expect(409); // ya hay un registro vigente
      const row = await ctx.db.reauthProof.findFirstOrThrow({ where: { userId: w.admin.user.id, purpose: PURPOSE }, orderBy: { createdAt: 'desc' } });
      expect(row.usedAt).toBeNull();
    });

    it('la plataforma y el resto del personal no pueden registrarlo ni leerlo', async () => {
      const w = await world();
      const body = { ...recordBody(), reauthToken: 'rp_' + 'A'.repeat(43) };
      await postRecord(w.platformToken, body).expect(403);
      await ctx.http().get('/v1/provisioning-records').set(bearer(w.platformToken)).expect(403);
      for (const role of ['RECEPTIONIST', 'DENTIST', 'CASHIER', 'ASSISTANT']) {
        const actor = await actorIn(ctx, fx, role, { clinicId: w.clinic.id });
        await postRecord(actor.token, body).expect(403);
        await ctx.http().get('/v1/provisioning-records').set(bearer(actor.token)).expect(403);
      }
      await postRecord('', body).expect(401);
    });

    it('valida el documento, las fechas y los textos', async () => {
      const w = await world();
      const attempt = async (over: Record<string, unknown>) => {
        const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
        return postRecord(w.admin.token, { ...recordBody(over), reauthToken: proof });
      };
      expect((await attempt({ authorizedByDocumentNumber: '1234567' })).status).toBe(400);
      expect((await attempt({ authorizedByDocumentType: 'RUC', authorizedByDocumentNumber: '2010000000' })).status).toBe(400);
      expect((await attempt({ authorizedByDocumentType: 'LICENCIA' })).status).toBe(400);
      expect((await attempt({ authorizationDate: '2999-01-01' })).status).toBe(400);
      expect((await attempt({ authorizationDate: yearsAgo(2) })).status).toBe(400);
      expect((await attempt({ authorizationDate: '2026-02-30' })).status).toBe(400);
      expect((await attempt({ authorizationReference: 'abc' })).status).toBe(400);
      expect((await attempt({ designeeEmail: 'no-es-correo' })).status).toBe(400);
      expect((await attempt({ extra: 'x' })).status).toBe(400);
      expect(await ctx.db.provisioningRecord.count({ where: { clinicId: w.clinic.id } })).toBe(0);
      expect((await attempt({ authorizedByDocumentType: 'RUC', authorizedByDocumentNumber: '20100000001' })).status).toBe(201);
    });

    it('se puede designar a sí mismo, pero queda marcado en la auditoría', async () => {
      const w = await world();
      const { id } = await record(w, { designeeEmail: w.admin.user.email });
      const [log] = await ctx.db.auditLog.findMany({ where: { entityId: id, action: 'PROVISIONING_RECORDED' } });
      expect(log!.summary).toMatchObject({ selfDesignation: true });
    });

    it('lista los registros de su clínica (documento enmascarado) y no los de otras', async () => {
      const w = await world();
      const { id } = await record(w);
      const list = await ctx.http().get('/v1/provisioning-records').set(bearer(w.admin.token)).expect(200);
      expect(list.body.map((r: { id: string }) => r.id)).toEqual([id]);
      expect(JSON.stringify(list.body)).not.toContain('45678901');
      expect((await ctx.http().get('/v1/provisioning-records').set(bearer(w.adminOther.token)).expect(200)).body).toEqual([]);
      await ctx.http().post(`/v1/provisioning-records/${id}/revoke`).set(bearer(w.adminOther.token)).send({ reason: 'intento ajeno' }).expect(404);
    });

    it('revocarlo exige motivo y revoca la invitación de Director pendiente que dependa de él', async () => {
      const w = await world();
      const rec = await record(w);
      const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      const inv = await inviteOk(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof });
      const revoke = (body: object) => ctx.http().post(`/v1/provisioning-records/${rec.id}/revoke`).set(bearer(w.admin.token)).send(body);
      await revoke({}).expect(400);
      const res = await revoke({ reason: 'Error en el acta citada' }).expect(200);
      expect(res.body).toMatchObject({ status: 'REVOKED', revokeReason: 'Error en el acta citada' });
      expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('REVOKED');
      await acceptReq(ctx, inv.token).expect(404);
      await revoke({ reason: 'otra vez' }).expect(409);
      expect(await ctx.db.auditLog.count({ where: { entityId: rec.id, action: 'PROVISIONING_REVOKED' } })).toBe(1);
      // tras revocar se puede registrar uno nuevo
      await record(w);
    });

    it('vence a los 30 días: se marca EXPIRED (una sola vez) y ya no sirve para invitar', async () => {
      const w = await world();
      const rec = await record(w);
      await ctx.db.provisioningRecord.update({ where: { id: rec.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      await inviteReq(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof }).expect(403);
      const list = await ctx.http().get('/v1/provisioning-records').set(bearer(w.admin.token)).expect(200);
      expect(list.body[0].status).toBe('EXPIRED');
      expect(await ctx.db.auditLog.count({ where: { entityId: rec.id, action: 'PROVISIONING_EXPIRED' } })).toBe(1);
      await record(w); // el registro vencido libera el cupo
    });

    it('el contenido del registro es inmutable y no se elimina (base de datos)', async () => {
      const w = await world();
      const { id } = await record(w);
      await expect(ctx.db.provisioningRecord.update({ where: { id }, data: { designeeEmail: 'otro@test.pe' } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.provisioningRecord.update({ where: { id }, data: { authorizationReference: 'Otro documento' } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.provisioningRecord.update({ where: { id }, data: { recordedById: w.adminOther.user.id } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.provisioningRecord.delete({ where: { id } })).rejects.toThrow(/eliminación física/);
    });
  });

  describe('designación del primer Director Clínico', () => {
    it('requiere registro vigente de la clínica, correo coincidente, reautenticación y no admite sede', async () => {
      const w = await world();
      const rec = await record(w);
      const send = async (over: Record<string, unknown>, reauth = true) => {
        const proof = reauth ? await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id) : undefined;
        return inviteReq(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, ...(proof ? { reauthToken: proof } : {}), ...over });
      };
      expect((await send({}, false)).status).toBe(400); // sin reautenticación
      expect((await send({ provisioningRecordId: undefined })).status).toBe(400); // sin registro
      expect((await send({ provisioningRecordId: randomUUID() })).status).toBe(403); // registro inexistente
      expect((await send({ email: designee() })).status).toBe(403); // otro destinatario
      expect((await send({ branchId: randomUUID() })).status).toBe(400); // el Director es de toda la clínica

      // el registro de OTRA clínica no sirve
      const otherRec = await (async () => {
        const proof = await reauthProofFor(ctx, w.adminOther.token, PURPOSE, w.other.id);
        return (await postRecord(w.adminOther.token, { ...recordBody(), reauthToken: proof }).expect(201)).body.id as string;
      })();
      expect((await send({ provisioningRecordId: otherRec })).status).toBe(403);
      expect(await ctx.db.invitation.count({ where: { clinicId: w.clinic.id } })).toBe(0);

      expect((await send({})).status).toBe(201);
    });

    it('la plataforma no puede designar al Director, ni ver ni gestionar sus invitaciones', async () => {
      const w = await world();
      const rec = await record(w);
      const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      const inv = await inviteOk(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof });
      await inviteReq(ctx, w.platformToken, { email: designee(), roleCode: 'CLINICAL_DIRECTOR', clinicId: w.clinic.id }).expect(403);
      const list = await ctx.http().get('/v1/invitations?limit=100').set(bearer(w.platformToken)).expect(200);
      expect(list.body.map((i: { id: string }) => i.id)).not.toContain(inv.id);
      await ctx.http().post(`/v1/invitations/${inv.id}/revoke`).set(bearer(w.platformToken)).send({ reason: 'intento' }).expect(404);
      await ctx.http().post(`/v1/invitations/${inv.id}/resend`).set(bearer(w.platformToken)).send({}).expect(404);
      expect((await ctx.db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PENDING');
    });

    it('un solo Director pendiente mientras no haya ninguno; el segundo exige revocar el primero', async () => {
      const w = await world();
      const rec = await record(w);
      const first = await (async () => {
        const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
        return inviteOk(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof });
      })();
      const proof2 = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      const dup = await inviteReq(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof2 }).expect(409);
      expect(dup.body.message).toMatch(/pendiente/);
      await ctx.http().post(`/v1/invitations/${first.id}/revoke`).set(bearer(w.admin.token)).send({ reason: 'Se corrige el envío' }).expect(200);
      expect((await inviteReq(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof2 })).status).toBe(201);
    });

    it('al aceptar: el designado obtiene el rol, el registro se CONSUME y todo queda auditado', async () => {
      const w = await world();
      const d = await firstDirector(w);
      const assignment = await ctx.db.userAssignment.findFirstOrThrow({ where: { user: { email: d.email } }, include: { role: true } });
      expect(assignment).toMatchObject({ clinicId: w.clinic.id, branchId: null, status: 'ACTIVE' });
      expect(assignment.role.code).toBe('CLINICAL_DIRECTOR');

      const record = await ctx.db.provisioningRecord.findUniqueOrThrow({ where: { id: d.rec.id } });
      expect(record).toMatchObject({ status: 'CONSUMED', activeKey: null, consumedInvitationId: d.inv.id });
      expect(record.consumedAt).toBeInstanceOf(Date);

      const logs = await ctx.db.auditLog.findMany({ where: { clinicId: w.clinic.id, action: { in: ['PROVISIONING_CONSUMED', 'DIRECTOR_ROLE_GRANTED', 'INVITATION_ACCEPTED'] } } });
      expect(logs.map((l) => l.action).sort((a, b) => a.localeCompare(b))).toEqual(['DIRECTOR_ROLE_GRANTED', 'INVITATION_ACCEPTED', 'PROVISIONING_CONSUMED']);
      const granted = logs.find((l) => l.action === 'DIRECTOR_ROLE_GRANTED')!;
      expect(granted.summary).toMatchObject({ invitationId: d.inv.id, grantedBy: w.admin.user.id, provisioningRecordId: d.rec.id });
    });

    it('el Director recibe clinical:read_all (lectura excepcional) y NINGÚN otro permiso clínico: no escribe ni lee por relación', async () => {
      const w = await world();
      const d = await firstDirector(w);
      const me = await ctx.http().get('/v1/auth/me').set(bearer(d.token)).expect(200);
      expect(me.body.roles).toEqual(['CLINICAL_DIRECTOR']);
      expect(me.body.permissions).toEqual(expect.arrayContaining(['director:manage', 'provisioning:read', 'invitation:read']));
      expect(me.body.permissions.filter((p: string) => p.startsWith('clinical:'))).toEqual(['clinical:read_all']);
      expect(me.body.permissions).not.toContain('invitation:manage');
      expect(me.body.permissions).not.toContain('provisioning:record');
      await inviteReq(ctx, d.token, { email: designee(), roleCode: 'DENTIST' }).expect(403); // el Director no invita personal
    });

    it('una vez designado un Director: el administrador ya no puede designar otro ni registrar otro aprovisionamiento', async () => {
      const w = await world();
      await firstDirector(w);
      const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      const res = await inviteReq(ctx, w.admin.token, { email: designee(), roleCode: 'CLINICAL_DIRECTOR', reauthToken: proof }).expect(403);
      expect(res.body.message).toMatch(/Solo un Director Clínico vigente/);
      const proof2 = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      const rec = await postRecord(w.admin.token, { ...recordBody(), reauthToken: proof2 }).expect(409);
      expect(rec.body.message).toMatch(/ya tiene un Director/);
    });

    it('un Director vigente designa a otro con reautenticación y sin registro de aprovisionamiento', async () => {
      const w = await world();
      const d = await firstDirector(w);
      const to = designee();
      await inviteReq(ctx, d.token, { email: to, roleCode: 'CLINICAL_DIRECTOR' }).expect(400); // sin reautenticación
      const proof = await reauthProofFor(ctx, d.token, PURPOSE, w.clinic.id, NEW_PASSWORD);
      await inviteReq(ctx, d.token, { email: to, roleCode: 'CLINICAL_DIRECTOR', reauthToken: proof, provisioningRecordId: d.rec.id }).expect(400);
      const proof2 = await reauthProofFor(ctx, d.token, PURPOSE, w.clinic.id, NEW_PASSWORD);
      const inv = await inviteOk(ctx, d.token, { email: to, roleCode: 'CLINICAL_DIRECTOR', reauthToken: proof2 });
      await acceptReq(ctx, inv.token).expect(200);
      expect(await ctx.db.userAssignment.count({ where: { clinicId: w.clinic.id, status: 'ACTIVE', role: { code: 'CLINICAL_DIRECTOR' } } })).toBe(2);
      const firstDirectorUser = await ctx.db.user.findUniqueOrThrow({ where: { email: d.email } });
      const grants = await ctx.db.auditLog.findMany({ where: { clinicId: w.clinic.id, action: 'DIRECTOR_ROLE_GRANTED' } });
      const second = grants.find((g) => (g.summary as { invitationId: string }).invitationId === inv.id)!;
      expect(second.summary).toMatchObject({ grantedBy: firstDirectorUser.id, provisioningRecordId: null });
      // el Director de OTRA clínica no puede designar en esta
      const otherDir = await firstDirector({ ...w, clinic: w.other, admin: w.adminOther });
      const p = await reauthProofFor(ctx, otherDir.token, PURPOSE, w.clinic.id, NEW_PASSWORD);
      await inviteReq(ctx, otherDir.token, { email: designee(), roleCode: 'CLINICAL_DIRECTOR', clinicId: w.clinic.id, reauthToken: p }).expect(403);
    });

    it('si el registro se revoca o vence antes de aceptar, la invitación ya no sirve', async () => {
      const w = await world();
      const rec = await record(w);
      const proof = await reauthProofFor(ctx, w.admin.token, PURPOSE, w.clinic.id);
      const inv = await inviteOk(ctx, w.admin.token, { email: rec.body.designeeEmail, roleCode: 'CLINICAL_DIRECTOR', provisioningRecordId: rec.id, reauthToken: proof });
      await ctx.db.provisioningRecord.update({ where: { id: rec.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await acceptReq(ctx, inv.token).expect(404);
      expect((await ctx.db.auditLog.findMany({ where: { entityId: inv.id, action: 'INVITATION_REJECTED' } }))[0]!.summary).toEqual({ reason: 'provisioning_not_usable' });
      expect(await ctx.db.userAssignment.count({ where: { clinicId: w.clinic.id, role: { code: 'CLINICAL_DIRECTOR' } } })).toBe(0);
    });

    it('el rol Director solo existe por invitación: ni asignación directa ni invitación por la plataforma', async () => {
      const w = await world();
      const target = await fx.user();
      await ctx.http().post('/v1/assignments').set(bearer(w.admin.token)).send({ userId: target.id, roleCode: 'CLINICAL_DIRECTOR' }).expect(403);
      await ctx.http().post('/v1/assignments').set(bearer(w.platformToken)).send({ userId: target.id, roleCode: 'CLINICAL_DIRECTOR', clinicId: w.clinic.id }).expect(403);
      expect(await ctx.db.userAssignment.count({ where: { role: { code: 'CLINICAL_DIRECTOR' }, userId: target.id } })).toBe(0);
    });
  });
});
