import { MaintenanceService } from '../src/maintenance/maintenance.service.js';
import {
  actorIn,
  assignCare,
  assignCareReq,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  loginInContext,
  revokeCareReq,
  summaryReq,
  type TestContext,
  uniq,
} from './helpers/app.js';

describe('Relación asistencial (care:assign)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const clinic = await fx.clinic();
    const branchA = await fx.branch(clinic.id);
    const branchB = await fx.branch(clinic.id);
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
      clinicId: clinic.id,
    });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', {
      clinicId: clinic.id,
    });
    const dentist = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
    const dentistToken = await loginInContext(ctx, dentist.user.email, {
      clinicId: clinic.id,
    });
    const { id: patientId } = await createPatient(ctx, reception.token);
    return {
      clinic,
      branchA,
      branchB,
      admin,
      reception,
      dentist,
      dentistToken,
      patientId,
    };
  }
  const auditOf = (patientId: string, action: string) =>
    ctx.db.auditLog.findMany({ where: { patientId, action } });
  const activeCount = (where: object) =>
    ctx.db.patientCareRelationship.count({
      where: { status: 'ACTIVE', ...where },
    });

  describe('crear', () => {
    it('recepción asigna el paciente a un odontólogo: queda explícita, auditada y no da acceso de escritura a quien la creó (recepción solo ve)', async () => {
      const w = await world();
      const res = await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: w.dentist.user.id,
        reason: 'Primera consulta',
      }).expect(201);
      expect(res.body).toMatchObject({
        patientId: w.patientId,
        dentist: { userId: w.dentist.user.id },
        branchId: null,
        source: 'ASSIGNMENT',
        status: 'ACTIVE',
        validUntil: null,
        reason: 'Primera consulta',
        createdById: w.reception.user.id,
      });
      const [log] = await auditOf(w.patientId, 'CARE_RELATIONSHIP_CREATED');
      expect(log).toMatchObject({
        userId: w.reception.user.id,
        clinicId: w.clinic.id,
      });
      expect(log!.summary).toMatchObject({
        dentistUserId: w.dentist.user.id,
        source: 'ASSIGNMENT',
        scope: 'clinic',
      });
      // asignar no da acceso clínico: recepción solo tiene su vista de lectura (sin escribir); administración lo tiene por su rol, no por la asignación
      await summaryReq(ctx, (await actorIn(ctx, fx, 'CASHIER', { clinicId: w.clinic.id })).token, w.patientId).expect(403);
      expect((await summaryReq(ctx, w.reception.token, w.patientId).expect(200)).body.access).toMatchObject({ level: 'VIEW', readOnly: true });
      expect(
        (await ctx.db.auditLog.findMany({ where: { patientId: w.patientId, userId: w.reception.user.id, action: 'CLINICAL_RECORD_VIEWED' } }))[0]?.summary,
      ).toMatchObject({ level: 'VIEW', via: 'view_only', relationshipIds: [] });
    });

    it('una sola relación vigente por paciente, odontólogo y sede; alcances distintos pueden coexistir', async () => {
      const w = await world();
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      const dup = await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: w.dentist.user.id,
      }).expect(409);
      expect(dup.body).toMatchObject({ code: 'RELATIONSHIP_EXISTS' });
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id, {
        branchId: w.branchA.id,
      });
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: w.dentist.user.id,
        branchId: w.branchA.id,
      }).expect(409);
    });

    it('el destinatario debe ser odontólogo vigente de ESTA clínica: 404 uniforme (no revela usuarios de otras clínicas)', async () => {
      const w = await world();
      const otherClinic = await fx.clinic();
      const foreignDentist = await fx.userWithRole('DENTIST', {
        clinicId: otherClinic.id,
      });
      const assistant = await fx.userWithRole('ASSISTANT', {
        clinicId: w.clinic.id,
      });
      const disabled = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      await ctx.db.user.update({
        where: { id: disabled.user.id },
        data: { status: 'DISABLED' },
      });
      const responses = [];
      for (const id of [
        foreignDentist.user.id,
        assistant.user.id,
        disabled.user.id,
        '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11',
      ]) {
        const res = await assignCareReq(ctx, w.reception.token, w.patientId, {
          dentistUserId: id,
        }).expect(404);
        responses.push(res.body.message);
      }
      expect(new Set(responses).size).toBe(1);
      expect(await activeCount({ patientId: w.patientId })).toBe(0);
    });

    it('sin escalamiento entre clínicas: no se asigna un paciente ajeno ni se usa un odontólogo ajeno', async () => {
      const w = await world();
      const other = await fx.clinic();
      const receptionB = await actorIn(ctx, fx, 'RECEPTIONIST', {
        clinicId: other.id,
      });
      const dentistB = await fx.userWithRole('DENTIST', { clinicId: other.id });
      // paciente de A visto desde B
      await assignCareReq(ctx, receptionB.token, w.patientId, {
        dentistUserId: dentistB.user.id,
      }).expect(404);
      // odontólogo de A para un paciente de B
      const { id: patientB } = await createPatient(ctx, receptionB.token);
      await assignCareReq(ctx, receptionB.token, patientB, {
        dentistUserId: w.dentist.user.id,
      }).expect(404);
      // sede de otra clínica
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: w.dentist.user.id,
        branchId: (await fx.branch(other.id)).id,
      }).expect(400);
      expect(
        await ctx.db.patientCareRelationship.count({
          where: { OR: [{ patientId: w.patientId }, { patientId: patientB }] },
        }),
      ).toBe(0);
    });

    it('con sede: el odontólogo debe trabajar en ella; la sede debe existir en la clínica', async () => {
      const w = await world();
      const inA = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: inA.user.id,
        branchId: w.branchB.id,
      }).expect(404);
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: inA.user.id,
        branchId: w.branchA.id,
      }).expect(201);
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: inA.user.id,
        branchId: 'no-es-uuid',
      }).expect(400);
    });

    it('las fuentes cita y visita están reservadas: la API no permite elegir el origen', async () => {
      const w = await world();
      for (const source of ['APPOINTMENT', 'VISIT']) {
        await assignCareReq(ctx, w.reception.token, w.patientId, {
          dentistUserId: w.dentist.user.id,
          source,
        }).expect(400);
      }
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      expect(rel).toMatchObject({ source: 'ASSIGNMENT' });
    });

    it('un paciente inactivo no recibe nuevas relaciones', async () => {
      const w = await world();
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/deactivate`)
        .set(bearer(w.reception.token))
        .send({ reason: 'Fallecimiento informado' })
        .expect(200);
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: w.dentist.user.id,
      }).expect(409);
    });

    it('solo quien tiene care:assign: odontólogo, asistente, caja y plataforma no asignan', async () => {
      const w = await world();
      const cashier = await actorIn(ctx, fx, 'CASHIER', {
        clinicId: w.clinic.id,
      });
      const assistant = await actorIn(ctx, fx, 'ASSISTANT', {
        clinicId: w.clinic.id,
      });
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platformToken = await loginInContext(ctx, user.email);
      for (const token of [
        w.dentistToken,
        cashier.token,
        assistant.token,
        platformToken,
      ]) {
        await assignCareReq(ctx, token, w.patientId, {
          dentistUserId: w.dentist.user.id,
        }).expect(403);
      }
    });
  });

  describe('separación de funciones (no hay autoasignación)', () => {
    it('nadie se asigna pacientes a sí mismo, aunque tenga ambos roles', async () => {
      const w = await world();
      const both = await fx.user();
      await fx.assign(both.id, 'RECEPTIONIST', { clinicId: w.clinic.id });
      await fx.assign(
        both.id,
        'DENTIST',
        { clinicId: w.clinic.id },
        w.admin.user.id,
      );
      const token = await loginInContext(ctx, both.email, {
        clinicId: w.clinic.id,
      });
      const res = await assignCareReq(ctx, token, w.patientId, {
        dentistUserId: both.id,
      }).expect(403);
      expect(res.body.message).toMatch(/sí mismo/);
      const [log] = await ctx.db.auditLog.findMany({
        where: { action: 'ESCALATION_BLOCKED', userId: both.id },
      });
      expect(log!.summary).toMatchObject({
        reason: 'self_assignment',
        operation: 'care_assign',
      });
      expect(await activeCount({ dentistUserId: both.id })).toBe(0);
    });

    it('quien otorgó el rol de odontólogo no puede asignarle pacientes; otra persona sí', async () => {
      const w = await world();
      const dentist = await fx.userWithRole(
        'DENTIST',
        { clinicId: w.clinic.id },
        w.admin.user.id,
      ); // lo otorgó el administrador
      const denied = await assignCareReq(ctx, w.admin.token, w.patientId, {
        dentistUserId: dentist.user.id,
      }).expect(403);
      expect(denied.body.message).toMatch(/otorgó/);
      const [log] = await ctx.db.auditLog.findMany({
        where: { action: 'ESCALATION_BLOCKED', userId: w.admin.user.id },
      });
      expect(log!.summary).toMatchObject({ reason: 'separation_of_duties' });
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: dentist.user.id,
      }).expect(201);
    });

    it('el administrador de una sede solo opera dentro de ella', async () => {
      const w = await world();
      const dentist = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      const recA = await actorIn(ctx, fx, 'RECEPTIONIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await assignCareReq(ctx, recA.token, w.patientId, {
        dentistUserId: dentist.user.id,
        branchId: w.branchB.id,
      }).expect(403);
      const ok = await assignCareReq(ctx, recA.token, w.patientId, {
        dentistUserId: dentist.user.id,
      }).expect(201);
      expect(ok.body.branchId).toBe(w.branchA.id); // por omisión, su sede
      // una relación de otra sede es invisible para él
      const other = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        dentist.user.id,
        { branchId: w.branchB.id },
      );
      await revokeCareReq(ctx, recA.token, other.id).expect(404);
    });
  });

  describe('revocar y consultar', () => {
    it('revocar exige motivo, termina la relación (no la borra), audita y el odontólogo pierde el acceso de inmediato', async () => {
      const w = await world();
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      await summaryReq(ctx, w.dentistToken, w.patientId).expect(200);

      await revokeCareReq(ctx, w.reception.token, rel.id, 'x').expect(400);
      await revokeCareReq(ctx, w.reception.token, rel.id, null).expect(400);
      const res = await revokeCareReq(
        ctx,
        w.reception.token,
        rel.id,
        'El paciente cambió de odontólogo',
      ).expect(200);
      expect(res.body).toMatchObject({
        status: 'ENDED',
        endKind: 'REVOKED',
        endReason: 'El paciente cambió de odontólogo',
        endedById: w.reception.user.id,
      });
      const row = await ctx.db.patientCareRelationship.findUniqueOrThrow({
        where: { id: rel.id },
      });
      expect(row).toMatchObject({ status: 'ENDED', activeKey: null });
      const [log] = await auditOf(w.patientId, 'CARE_RELATIONSHIP_REVOKED');
      expect(log).toMatchObject({ userId: w.reception.user.id });
      expect(log!.summary).toMatchObject({
        reason: 'El paciente cambió de odontólogo',
      });

      const denied = await summaryReq(ctx, w.dentistToken, w.patientId).expect(
        403,
      );
      expect(denied.body.code).toBe('NO_CARE_RELATIONSHIP');
      await revokeCareReq(ctx, w.reception.token, rel.id).expect(409);
      // la vigencia termina, pero se puede volver a asignar (nueva fila, historial intacto)
      await assignCareReq(ctx, w.reception.token, w.patientId, {
        dentistUserId: w.dentist.user.id,
      }).expect(201);
      expect(
        await ctx.db.patientCareRelationship.count({
          where: { patientId: w.patientId },
        }),
      ).toBe(2);
    });

    it('una relación de otra clínica o inexistente responde 404 igual', async () => {
      const w = await world();
      const other = await fx.clinic();
      const receptionB = await actorIn(ctx, fx, 'RECEPTIONIST', {
        clinicId: other.id,
      });
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      const foreign = await revokeCareReq(ctx, receptionB.token, rel.id).expect(
        404,
      );
      const ghost = await revokeCareReq(
        ctx,
        receptionB.token,
        '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11',
      ).expect(404);
      expect(foreign.body.message).toBe(ghost.body.message);
      expect(
        (
          await ctx.db.patientCareRelationship.findUniqueOrThrow({
            where: { id: rel.id },
          })
        ).status,
      ).toBe('ACTIVE');
    });

    it('lista por paciente y de la clínica (auditado); muestra quién otorgó el rol del odontólogo para revisión', async () => {
      const w = await world();
      const granted = await fx.userWithRole(
        'DENTIST',
        { clinicId: w.clinic.id },
        w.admin.user.id,
      );
      await assignCare(ctx, w.reception.token, w.patientId, granted.user.id);
      const list = await ctx
        .http()
        .get(`/v1/patients/${w.patientId}/care-relationships`)
        .set(bearer(w.admin.token))
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        dentist: { userId: granted.user.id },
        status: 'ACTIVE',
      });
      expect(
        await auditOf(w.patientId, 'CARE_RELATIONSHIPS_LISTED'),
      ).toHaveLength(1);

      const clinicWide = await ctx
        .http()
        .get('/v1/care-relationships?status=ACTIVE&limit=10')
        .set(bearer(w.admin.token))
        .expect(200);
      expect(clinicWide.body[0]).toMatchObject({
        dentistRoleGrantedById: w.admin.user.id,
      });
      await ctx
        .http()
        .get(`/v1/care-relationships?dentistUserId=${granted.user.id}`)
        .set(bearer(w.admin.token))
        .expect(200);
      // el odontólogo no ve el panel administrativo
      await ctx
        .http()
        .get(`/v1/patients/${w.patientId}/care-relationships`)
        .set(bearer(w.dentistToken))
        .expect(403);
      // otra clínica no ve nada
      const other = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
        clinicId: (await fx.clinic()).id,
      });
      expect(
        (
          await ctx
            .http()
            .get('/v1/care-relationships')
            .set(bearer(other.token))
            .expect(200)
        ).body,
      ).toEqual([]);
      await ctx
        .http()
        .get(`/v1/patients/${w.patientId}/care-relationships`)
        .set(bearer(other.token))
        .expect(404);
    });
  });

  describe('vigencia y ciclo de vida', () => {
    it('una relación con vigencia vencida deja de dar acceso y el mantenimiento la cierra (EXPIRED)', async () => {
      const w = await world();
      const rel = await ctx.db.patientCareRelationship.create({
        data: {
          clinicId: w.clinic.id,
          patientId: w.patientId,
          dentistUserId: w.dentist.user.id,
          source: 'APPOINTMENT',
          sourceRef: uniq('cita'),
          activeKey: `${w.patientId}|${w.dentist.user.id}|*`,
          validUntil: new Date(Date.now() - 60_000),
          createdById: w.reception.user.id,
        },
      });
      const denied = await summaryReq(ctx, w.dentistToken, w.patientId).expect(
        403,
      ); // aún ACTIVE en la tabla, pero vencida
      expect(denied.body.code).toBe('NO_CARE_RELATIONSHIP');
      const report = await ctx.app.get(MaintenanceService).run();
      expect(report.expired.careRelationships).toBeGreaterThanOrEqual(1);
      expect(
        await ctx.db.patientCareRelationship.findUniqueOrThrow({
          where: { id: rel.id },
        }),
      ).toMatchObject({ status: 'ENDED', endKind: 'EXPIRED', activeKey: null });
      expect(
        await auditOf(w.patientId, 'CARE_RELATIONSHIP_ENDED'),
      ).toHaveLength(1);
    });

    it('retirar el rol de odontólogo termina sus relaciones; reasignar el rol NO las restaura', async () => {
      const w = await world();
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      await ctx
        .http()
        .patch(`/v1/assignments/${w.dentist.assignment.id}/revoke`)
        .set(bearer(w.admin.token))
        .send()
        .expect(200);
      expect(
        await ctx.db.patientCareRelationship.findUniqueOrThrow({
          where: { id: rel.id },
        }),
      ).toMatchObject({
        status: 'ENDED',
        endKind: 'SYSTEM',
        endReason: 'Se retiró el rol de odontólogo',
      });
      await ctx
        .http()
        .post('/v1/assignments')
        .set(bearer(w.admin.token))
        .send({ userId: w.dentist.user.id, roleCode: 'DENTIST' })
        .expect(201);
      const back = await loginInContext(ctx, w.dentist.user.email, {
        clinicId: w.clinic.id,
      });
      const denied = await summaryReq(ctx, back, w.patientId).expect(403);
      expect(denied.body.code).toBe('NO_CARE_RELATIONSHIP');
    });

    it('con dos roles de odontólogo (dos sedes), retirar uno conserva las relaciones; retirar el último las termina', async () => {
      const w = await world();
      const d = await fx.user();
      const a = await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const b = await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      const rel = await assignCare(ctx, w.reception.token, w.patientId, d.id);
      await ctx
        .http()
        .patch(`/v1/assignments/${a.id}/revoke`)
        .set(bearer(w.admin.token))
        .send()
        .expect(200);
      expect(
        (
          await ctx.db.patientCareRelationship.findUniqueOrThrow({
            where: { id: rel.id },
          })
        ).status,
      ).toBe('ACTIVE');
      await ctx
        .http()
        .patch(`/v1/assignments/${b.id}/revoke`)
        .set(bearer(w.admin.token))
        .send()
        .expect(200);
      expect(
        (
          await ctx.db.patientCareRelationship.findUniqueOrThrow({
            where: { id: rel.id },
          })
        ).status,
      ).toBe('ENDED');
    });

    it('deshabilitar al odontólogo termina sus relaciones; reactivarlo no las restaura', async () => {
      const w = await world();
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      await ctx
        .http()
        .post(`/v1/users/${w.dentist.user.id}/disable`)
        .set(bearer(w.admin.token))
        .send({ reason: 'Licencia prolongada' })
        .expect(200);
      expect(
        await ctx.db.patientCareRelationship.findUniqueOrThrow({
          where: { id: rel.id },
        }),
      ).toMatchObject({
        status: 'ENDED',
        endKind: 'SYSTEM',
        endReason: 'Usuario deshabilitado',
      });
      await ctx
        .http()
        .post(`/v1/users/${w.dentist.user.id}/reactivate`)
        .set(bearer(w.admin.token))
        .send({ reason: 'Regresa' })
        .expect(200);
      const back = await loginInContext(ctx, w.dentist.user.email, {
        clinicId: w.clinic.id,
      });
      await summaryReq(ctx, back, w.patientId).expect(403);
    });
  });

  describe('garantías de la base de datos', () => {
    const sql = (ctx0: TestContext, text: string, ...values: unknown[]) =>
      ctx0.db.$executeRawUnsafe(text, ...values);

    it('el contenido no cambia, solo se termina con motivo, nunca se reabre ni se borra', async () => {
      const w = await world();
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      const other = await fx.user();
      await expect(
        sql(
          ctx,
          'UPDATE patient_care_relationships SET dentist_user_id = ? WHERE id = ?',
          other.id,
          rel.id,
        ),
      ).rejects.toThrow(/inmutables/);
      await expect(
        sql(
          ctx,
          "UPDATE patient_care_relationships SET reason = 'otro' WHERE id = ?",
          rel.id,
        ),
      ).rejects.toThrow(/inmutables/);
      await expect(
        sql(
          ctx,
          "UPDATE patient_care_relationships SET status = 'ENDED' WHERE id = ?",
          rel.id,
        ),
      ).rejects.toThrow(/terminarla, con motivo/);
      await expect(
        sql(
          ctx,
          "UPDATE patient_care_relationships SET status = 'ENDED', active_key = NULL, ended_at = NOW(3), end_kind = 'REVOKED', end_reason = 'x' WHERE id = ?",
          rel.id,
        ),
      ).rejects.toThrow(/terminarla, con motivo/);
      await expect(
        sql(ctx, 'DELETE FROM patient_care_relationships WHERE id = ?', rel.id),
      ).rejects.toThrow(/no se eliminan/);
      await revokeCareReq(ctx, w.reception.token, rel.id).expect(200);
      await expect(
        sql(
          ctx,
          "UPDATE patient_care_relationships SET status = 'ACTIVE' WHERE id = ?",
          rel.id,
        ),
      ).rejects.toThrow(/inmutables|terminada/);
      await expect(
        sql(
          ctx,
          "UPDATE patient_care_relationships SET end_reason = 'cambio' WHERE id = ?",
          rel.id,
        ),
      ).rejects.toThrow(/terminada/);
    });

    it('una relación nace activa y la base impide cruzar clínicas (FK compuestas)', async () => {
      const w = await world();
      const other = await fx.clinic();
      const base = {
        patientId: w.patientId,
        dentistUserId: w.dentist.user.id,
        createdById: w.reception.user.id,
        source: 'ASSIGNMENT' as const,
      };
      await expect(
        ctx.db.patientCareRelationship.create({
          data: {
            ...base,
            clinicId: w.clinic.id,
            status: 'ENDED',
            activeKey: null,
            endedAt: new Date(),
            endKind: 'REVOKED',
            endReason: 'x',
          },
        }),
      ).rejects.toThrow(/nace activa/);
      // paciente de la clínica A con clinic_id de B
      await expect(
        ctx.db.patientCareRelationship.create({
          data: { ...base, clinicId: other.id, activeKey: uniq('k') },
        }),
      ).rejects.toThrow();
      // sede de otra clínica
      await expect(
        ctx.db.patientCareRelationship.create({
          data: {
            ...base,
            clinicId: w.clinic.id,
            branchId: (await fx.branch(other.id)).id,
            activeKey: uniq('k'),
          },
        }),
      ).rejects.toThrow();
      expect(
        await ctx.db.patientCareRelationship.count({
          where: { patientId: w.patientId },
        }),
      ).toBe(0);
    });
  });

  describe('concurrencia', () => {
    it('muchas asignaciones idénticas a la vez: exactamente una prospera', async () => {
      const w = await world();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          assignCareReq(ctx, w.reception.token, w.patientId, {
            dentistUserId: w.dentist.user.id,
          }),
        ),
      );
      const statuses = results.map((r) => r.status).sort((x, y) => x - y);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      expect(await activeCount({ patientId: w.patientId })).toBe(1);
    });

    it('dos revocaciones simultáneas de la misma relación: una prospera y la otra recibe 409', async () => {
      const w = await world();
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      const [r1, r2] = await Promise.all([
        revokeCareReq(ctx, w.reception.token, rel.id, 'Motivo A'),
        revokeCareReq(ctx, w.admin.token, rel.id, 'Motivo B'),
      ]);
      expect([r1.status, r2.status].sort((x, y) => x - y)).toEqual([200, 409]);
      expect(
        await ctx.db.auditLog.count({
          where: { action: 'CARE_RELATIONSHIP_REVOKED', entityId: rel.id },
        }),
      ).toBe(1);
    });

    it('asignar mientras se retira el rol de odontólogo: nunca queda una relación vigente sin rol', async () => {
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const results = await Promise.all([
          assignCareReq(ctx, w.reception.token, w.patientId, {
            dentistUserId: w.dentist.user.id,
          }),
          ctx
            .http()
            .patch(`/v1/assignments/${w.dentist.assignment.id}/revoke`)
            .set(bearer(w.admin.token))
            .send(),
        ]);
        expect([201, 404], `ronda ${round}`).toContain(results[0].status);
        expect(results[1].status, `ronda ${round}`).toBe(200);
        expect(
          await activeCount({ dentistUserId: w.dentist.user.id }),
          `ronda ${round}`,
        ).toBe(0);
      }
    });

    it('asignar mientras se deshabilita al usuario: nunca queda una relación vigente de una cuenta deshabilitada', async () => {
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const results = await Promise.all([
          assignCareReq(ctx, w.reception.token, w.patientId, {
            dentistUserId: w.dentist.user.id,
          }),
          ctx
            .http()
            .post(`/v1/users/${w.dentist.user.id}/disable`)
            .set(bearer(w.admin.token))
            .send({ reason: 'Baja del personal' }),
        ]);
        expect([201, 404], `ronda ${round}`).toContain(results[0].status);
        expect(results[1].status, `ronda ${round}`).toBe(200);
        expect(
          await activeCount({ dentistUserId: w.dentist.user.id }),
          `ronda ${round}`,
        ).toBe(0);
      }
    });

    it('lecturas simultáneas a la revocación: cada lectura entregada quedó auditada y después ya no hay acceso', async () => {
      const w = await world();
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      const reads = Array.from({ length: 10 }, () =>
        summaryReq(ctx, w.dentistToken, w.patientId),
      );
      const [revoked, ...results] = await Promise.all([
        revokeCareReq(ctx, w.reception.token, rel.id),
        ...reads,
      ]);
      expect(revoked.status).toBe(200);
      const delivered = results.filter((r) => r.status === 200).length;
      expect(results.every((r) => r.status === 200 || r.status === 403)).toBe(
        true,
      );
      expect(await auditOf(w.patientId, 'CLINICAL_RECORD_VIEWED')).toHaveLength(
        delivered,
      );
      await summaryReq(ctx, w.dentistToken, w.patientId).expect(403);
    });
  });
});
