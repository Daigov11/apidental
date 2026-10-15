import {
  acceptReq,
  actorIn,
  assignCare,
  assignCareReq,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  inviteOk,
  inviteReq,
  loginInContext,
  NEW_PASSWORD,
  summaryReq,
  type TestContext,
  uniq,
} from './helpers/app.js';

describe('Escalamiento de acceso clínico: invitación, segunda identidad y autoasignación', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const clinic = await fx.clinic();
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
      clinicId: clinic.id,
    });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', {
      clinicId: clinic.id,
    });
    const { id: patientId } = await createPatient(ctx, reception.token);
    return { clinic, admin, reception, patientId };
  }
  const blocked = (userId: string, reason: string) =>
    ctx.db.auditLog
      .findMany({ where: { userId, action: 'ESCALATION_BLOCKED' } })
      .then((rows) =>
        rows.filter((r) => (r.summary as { reason: string }).reason === reason),
      );

  describe('autoinvitación y segunda identidad por correo', () => {
    it('el administrador no puede invitar su propio correo, ni con otra capitalización, etiqueta o puntos de Gmail', async () => {
      const w = await world();
      const gmail = await fx.user({
        email: `jane.doe${uniq('')}@gmail.com`.toLowerCase(),
      });
      await fx.assign(gmail.id, 'CLINIC_ADMIN', { clinicId: w.clinic.id });
      const token = await loginInContext(ctx, gmail.email, {
        clinicId: w.clinic.id,
      });
      const [local] = gmail.email.split('@');
      const variants = [
        gmail.email,
        gmail.email.toUpperCase(),
        `${local}+consultorio@gmail.com`,
        `${local!.replace(/^(\w)/, '$1.')}@gmail.com`, // un punto más: misma bandeja en Gmail
        `${local}+x@googlemail.com`,
      ];
      for (const email of variants) {
        for (const roleCode of ['DENTIST', 'ASSISTANT', 'RECEPTIONIST']) {
          const res = await inviteReq(ctx, token, { email, roleCode }).expect(
            403,
          );
          expect(res.body.message).toMatch(/invitarse a sí mismo/);
        }
      }
      expect((await blocked(gmail.id, 'self_invitation')).length).toBe(
        variants.length * 3,
      );
      expect(
        await ctx.db.invitation.count({ where: { createdById: gmail.id } }),
      ).toBe(0);
    });

    it('el Director tampoco puede designarse a sí mismo con un alias', async () => {
      const w = await world();
      const dir = await fx.user({ email: `${uniq('dir')}@empresa.pe` });
      await fx.assign(dir.id, 'CLINICAL_DIRECTOR', { clinicId: w.clinic.id });
      const token = await loginInContext(ctx, dir.email, {
        clinicId: w.clinic.id,
      });
      const alias = dir.email.replace('@', '+otro@');
      await inviteReq(ctx, token, {
        email: alias,
        roleCode: 'CLINICAL_DIRECTOR',
        reauthToken: 'x'.repeat(20),
      }).expect(403);
      expect((await blocked(dir.id, 'self_invitation')).length).toBe(1);
    });

    it('la cuenta de quien invitó no puede aceptar su propia invitación aunque se la haya construido por otra vía', async () => {
      const w = await world();
      const { createHash } = await import('node:crypto');
      const role = await ctx.db.role.findUniqueOrThrow({
        where: { code: 'DENTIST' },
      });
      const token = 'inv_' + 'Z'.repeat(43);
      await ctx.db.invitation.create({
        data: {
          email: w.admin.user.email,
          roleId: role.id,
          clinicId: w.clinic.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          pendingKey: uniq('pk'),
          expiresAt: new Date(Date.now() + 3_600_000),
          createdById: w.admin.user.id,
        },
      });
      await acceptReq(ctx, token).expect((res) =>
        expect(res.status).toBeGreaterThanOrEqual(400),
      );
      expect(
        await ctx.db.userAssignment.count({
          where: { userId: w.admin.user.id, role: { code: 'DENTIST' } },
        }),
      ).toBe(0);
    });
  });

  describe('autoasignación de roles y de pacientes', () => {
    it('nadie se otorga roles a sí mismo (ni siquiera uno que podría conferir a otros)', async () => {
      const w = await world();
      for (const roleCode of [
        'DENTIST',
        'ASSISTANT',
        'RECEPTIONIST',
        'CLINICAL_DIRECTOR',
        'PLATFORM_ADMIN',
      ]) {
        await ctx
          .http()
          .post('/v1/assignments')
          .set(bearer(w.admin.token))
          .send({ userId: w.admin.user.id, roleCode })
          .expect(403);
      }
      expect(
        (await blocked(w.admin.user.id, 'self_grant')).length,
      ).toBeGreaterThanOrEqual(1);
      const roles = await ctx.db.userAssignment.findMany({
        where: { userId: w.admin.user.id, status: 'ACTIVE' },
        include: { role: true },
      });
      expect(roles.map((r) => r.role.code)).toEqual(['CLINIC_ADMIN']);
    });

    it('el administrador SÍ incorpora odontólogos y asistentes (no poseer clinical:* no es escalada), pero queda como quien otorgó el rol', async () => {
      const w = await world();
      const dentistEmail = `${uniq('doc')}@test.pe`;
      const { token } = await inviteOk(ctx, w.admin.token, {
        email: dentistEmail,
        roleCode: 'DENTIST',
      });
      await acceptReq(ctx, token).expect(200);
      const user = await ctx.db.user.findUniqueOrThrow({
        where: { email: dentistEmail },
      });
      const assignment = await ctx.db.userAssignment.findFirstOrThrow({
        where: { userId: user.id, role: { code: 'DENTIST' } },
      });
      expect(assignment.grantedById).toBe(w.admin.user.id); // no el propio invitado
      const [log] = await ctx.db.auditLog.findMany({
        where: { action: 'CLINICAL_ROLE_GRANTED', entityId: assignment.id },
      });
      expect(log!.summary).toMatchObject({
        roleCode: 'DENTIST',
        targetUserId: user.id,
        grantedById: w.admin.user.id,
      });

      // por asignación directa también
      const other = await fx.user();
      const direct = await ctx
        .http()
        .post('/v1/assignments')
        .set(bearer(w.admin.token))
        .send({ userId: other.id, roleCode: 'ASSISTANT' })
        .expect(201);
      expect(
        (
          await ctx.db.userAssignment.findUniqueOrThrow({
            where: { id: direct.body.id },
          })
        ).grantedById,
      ).toBe(w.admin.user.id);
    });

    it('la segunda identidad del administrador (otro correo) no le sirve: no puede asignarle pacientes ni él mismo ni con su cuenta principal', async () => {
      const w = await world();
      // el administrador invita "a otra persona" que en realidad controla
      const secondEmail = `${uniq('alias')}@otrodominio.pe`;
      const { token } = await inviteOk(ctx, w.admin.token, {
        email: secondEmail,
        roleCode: 'DENTIST',
      });
      await acceptReq(ctx, token).expect(200);
      const second = await ctx.db.user.findUniqueOrThrow({
        where: { email: secondEmail },
      });

      // 1) con su cuenta de administrador no puede asignarle pacientes
      const denied = await assignCareReq(ctx, w.admin.token, w.patientId, {
        dentistUserId: second.id,
      }).expect(403);
      expect(denied.body.message).toMatch(/otorgó/);
      expect(
        (await blocked(w.admin.user.id, 'separation_of_duties')).length,
      ).toBe(1);
      // 2) con la segunda identidad no se asigna a sí misma
      const secondToken = await loginInContext(
        ctx,
        second.email,
        { clinicId: w.clinic.id },
        NEW_PASSWORD,
      );
      await assignCareReq(ctx, secondToken, w.patientId, {
        dentistUserId: second.id,
      }).expect(403);
      // 3) sin relación, nada clínico
      const noAccess = await summaryReq(ctx, secondToken, w.patientId).expect(
        403,
      );
      expect(noAccess.body.code).toBe('NO_CARE_RELATIONSHIP');
      expect(
        await ctx.db.patientCareRelationship.count({
          where: { dentistUserId: second.id },
        }),
      ).toBe(0);

      // solo OTRA persona (recepción) puede asignar; queda a la vista del Director en el listado de revisión
      await assignCare(ctx, w.reception.token, w.patientId, second.id);
      const list = await ctx
        .http()
        .get(`/v1/care-relationships?dentistUserId=${second.id}`)
        .set(bearer(w.admin.token))
        .expect(200);
      expect(list.body[0]).toMatchObject({
        dentistRoleGrantedById: w.admin.user.id,
        createdById: w.reception.user.id,
      });
      await summaryReq(ctx, secondToken, w.patientId).expect(200);
    });

    it('limitación documentada: dos personas coludidas (administrador y recepción) sí logran acceso, pero todo queda trazado', async () => {
      const w = await world();
      const dentist = await fx.userWithRole(
        'DENTIST',
        { clinicId: w.clinic.id },
        w.admin.user.id,
      );
      await assignCare(ctx, w.reception.token, w.patientId, dentist.user.id);
      const trail = await ctx.db.auditLog.findMany({
        where: { patientId: w.patientId, action: 'CARE_RELATIONSHIP_CREATED' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({ userId: w.reception.user.id });
    });
  });

  describe('roles y permisos que no se pueden conferir', () => {
    it('ni la plataforma ni la administración otorgan clinical:read_all ni el rol Director por asignación o invitación común', async () => {
      const w = await world();
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platform = await loginInContext(ctx, user.email);
      const target = await fx.user();
      for (const token of [w.admin.token, platform]) {
        await ctx
          .http()
          .post('/v1/assignments')
          .set(bearer(token))
          .send({
            userId: target.id,
            roleCode: 'CLINICAL_DIRECTOR',
            ...(token === platform ? { clinicId: w.clinic.id } : {}),
          })
          .expect(403);
      }
      await inviteReq(ctx, platform, {
        email: `${uniq('p')}@test.pe`,
        roleCode: 'DENTIST',
        clinicId: w.clinic.id,
      }).expect(403); // la plataforma no invita personal
      await inviteReq(ctx, w.admin.token, {
        email: `${uniq('p')}@test.pe`,
        roleCode: 'CLINICAL_DIRECTOR',
      }).expect((r) => expect([400, 403]).toContain(r.status));
      expect(
        await ctx.db.userAssignment.count({ where: { userId: target.id } }),
      ).toBe(0);
    });

    it('un odontólogo o asistente no puede conferir roles clínicos ni asignar pacientes', async () => {
      const w = await world();
      const dentist = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: w.clinic.id,
      });
      const target = await fx.user();
      await ctx
        .http()
        .post('/v1/assignments')
        .set(bearer(dentist.token))
        .send({ userId: target.id, roleCode: 'ASSISTANT' })
        .expect(403);
      await inviteReq(ctx, dentist.token, {
        email: `${uniq('x')}@test.pe`,
        roleCode: 'ASSISTANT',
      }).expect(403);
      await assignCareReq(ctx, dentist.token, w.patientId, {
        dentistUserId: dentist.user.id,
      }).expect(403);
    });
  });
});
