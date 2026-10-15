import { LastAuthorityError, LastAuthorityService } from '../src/users/last-authority.service.js';
import { actorIn, bearer, createTestContext, Fixtures, loginInContext, type TestContext } from './helpers/app.js';

describe('Regla de último administrador / último Director', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function platformToken() {
    const { user } = await fx.userWithRole('PLATFORM_ADMIN');
    return loginInContext(ctx, user.email);
  }
  const revoke = (token: string, assignmentId: string) => ctx.http().patch(`/v1/assignments/${assignmentId}/revoke`).set(bearer(token)).send();
  const status = (id: string) => ctx.db.userAssignment.findUniqueOrThrow({ where: { id } }).then((a) => a.status);

  describe('administrador de la clínica', () => {
    it('se puede quitar a un administrador mientras quede otro; el último no', async () => {
      const clinic = await fx.clinic();
      const a = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const b = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const token = await platformToken();

      await revoke(token, a.assignment.id).expect(200);
      const blocked = await revoke(token, b.assignment.id).expect(409);
      expect(blocked.body).toMatchObject({ code: 'LAST_AUTHORITY', roleCode: 'CLINIC_ADMIN' });
      expect(blocked.body.message).toMatch(/último administrador de la clínica/);
      expect(await status(b.assignment.id)).toBe('ACTIVE');
      const [log] = await ctx.db.auditLog.findMany({ where: { action: 'LAST_AUTHORITY_BLOCKED', entityId: b.assignment.id } });
      expect(log).toMatchObject({ clinicId: clinic.id });
      expect(log!.summary).toEqual({ roleCode: 'CLINIC_ADMIN', blockedOperation: 'revoke' });
    });

    it('el administrador de una sede NO cuenta como autoridad de la clínica', async () => {
      const clinic = await fx.clinic();
      const branch = await fx.branch(clinic.id);
      const whole = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id, branchId: branch.id });
      await revoke(await platformToken(), whole.assignment.id).expect(409);
    });

    it('un administrador con usuario deshabilitado o asignación revocada no cuenta', async () => {
      const clinic = await fx.clinic();
      const live = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const disabled = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      await ctx.db.user.update({ where: { id: disabled.user.id }, data: { status: 'DISABLED' } });
      const revoked = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      await ctx.db.userAssignment.update({ where: { id: revoked.assignment.id }, data: { status: 'INACTIVE' } });
      await revoke(await platformToken(), live.assignment.id).expect(409);
    });

    it('un administrador de la propia clínica tampoco puede dejarla sin administración', async () => {
      const clinic = await fx.clinic();
      const keeper = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const other = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      await revoke(keeper.token, other.assignment.id).expect(200); // queda keeper
      expect(await status(other.assignment.id)).toBe('INACTIVE');
      // keeper ya no puede quitarse (regla de auto-revocación) y nadie más de la clínica puede hacerlo
      const own = await ctx.db.userAssignment.findFirstOrThrow({ where: { userId: keeper.user.id } });
      await revoke(keeper.token, own.id).expect(403);
    });

    it('dos revocaciones simultáneas no pueden dejar la clínica vacía: solo una prospera', async () => {
      const clinic = await fx.clinic();
      const a = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const b = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const t1 = await platformToken();
      const t2 = await platformToken();
      const results = await Promise.all([revoke(t1, a.assignment.id), revoke(t2, b.assignment.id)]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409]);
      expect(await ctx.db.userAssignment.count({ where: { clinicId: clinic.id, status: 'ACTIVE', role: { code: 'CLINIC_ADMIN' } } })).toBe(1);
    });

    it('revocar roles sin protección de "último" no se ve afectado', async () => {
      const clinic = await fx.clinic();
      await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const dentist = await fx.userWithRole('DENTIST', { clinicId: clinic.id });
      await revoke(await platformToken(), dentist.assignment.id).expect(200);
    });
  });

  describe('Director Clínico (protegido: solo OTRO Director vigente puede retirarle el rol)', () => {
    const blockedAudit = (clinicId: string) => ctx.db.auditLog.count({ where: { clinicId, action: 'DIRECTOR_PROTECTION_BLOCKED' } });

    it('ni la plataforma ni la administración retiran el rol de Director, aunque haya dos', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const d1 = await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      for (const token of [await platformToken(), admin.token]) {
        const res = await revoke(token, d1.assignment.id).expect(403);
        expect(res.body.message).toMatch(/otro Director Clínico vigente/);
      }
      expect(await status(d1.assignment.id)).toBe('ACTIVE');
      expect(await blockedAudit(clinic.id)).toBeGreaterThanOrEqual(1);
    });

    it('con dos Directores, uno retira al otro; el único que queda no puede ser retirado por nadie', async () => {
      const clinic = await fx.clinic();
      const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
      const d1 = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', { clinicId: clinic.id });
      const d2 = await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      const own = await ctx.db.userAssignment.findFirstOrThrow({ where: { userId: d1.user.id, status: 'ACTIVE' } });

      await revoke(d1.token, d2.assignment.id).expect(200);
      expect(await status(d2.assignment.id)).toBe('INACTIVE');
      // el último Director: ni él mismo, ni la administración, ni la plataforma
      await revoke(d1.token, own.id).expect(403);
      await revoke(admin.token, own.id).expect(403);
      await revoke(await platformToken(), own.id).expect(403);
      expect(await status(own.id)).toBe('ACTIVE');
    });

    it('una clínica sin Director no tiene nada que proteger; la regla de administrador es independiente', async () => {
      const clinic = await fx.clinic();
      const admin1 = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
      const dir = await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id });
      const token = await platformToken();
      await revoke(token, admin1.assignment.id).expect(200); // quedan administrador y Director
      await revoke(token, dir.assignment.id).expect(403); // el Director está protegido
    });

    it('dos Directores que se retiran mutuamente a la vez: solo uno prospera y siempre queda uno', async () => {
      for (let round = 0; round < 3; round++) {
        const clinic = await fx.clinic();
        const d1 = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', { clinicId: clinic.id });
        const d2 = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', { clinicId: clinic.id });
        const a1 = await ctx.db.userAssignment.findFirstOrThrow({ where: { userId: d1.user.id, status: 'ACTIVE' } });
        const a2 = await ctx.db.userAssignment.findFirstOrThrow({ where: { userId: d2.user.id, status: 'ACTIVE' } });
        const results = await Promise.all([revoke(d1.token, a2.id), revoke(d2.token, a1.id)]);
        const codes = results.map((r) => r.status).sort((x, y) => x - y);
        expect(codes[0], `ronda ${round}`).toBe(200);
        expect([403, 409]).toContain(codes[1]); // 409 = bloqueó la regla de último Director; 403 = ya había perdido el rol
        expect(await ctx.db.userAssignment.count({ where: { clinicId: clinic.id, status: 'ACTIVE', role: { code: 'CLINICAL_DIRECTOR' } } })).toBe(1);
      }
    });
  });

  describe('servicio (unidad, incluida la regla de plataforma)', () => {
    const service = new LastAuthorityService();
    const tx = (rows: { id: string }[]) => ({ $queryRaw: async () => rows }) as never;

    it('bloquea cuando no queda otra autoridad y permite cuando sí', async () => {
      const a = { id: 'x', roleCode: 'PLATFORM_ADMIN', clinicId: null, branchId: null };
      await expect(service.assertCanRemove(tx([]), a)).rejects.toThrow(LastAuthorityError);
      await expect(service.assertCanRemove(tx([]), a)).rejects.toThrow(/último administrador de plataforma/);
      await expect(service.assertCanRemove(tx([{ id: 'y' }]), a)).resolves.toBeUndefined();
      const clinicAdmin = { id: 'x', roleCode: 'CLINIC_ADMIN', clinicId: 'c', branchId: null };
      await expect(service.assertCanRemove(tx([]), clinicAdmin)).rejects.toThrow(/sin autoridad administrativa/);
      const director = { id: 'x', roleCode: 'CLINICAL_DIRECTOR', clinicId: 'c', branchId: null };
      await expect(service.assertCanRemove(tx([]), director)).rejects.toThrow(/sin autoridad clínica/);
    });

    it('no consulta nada para roles sin protección ni para administradores de una sola sede', async () => {
      const never = { $queryRaw: async () => { throw new Error('no debe consultar'); } } as never;
      await expect(service.assertCanRemove(never, { id: 'x', roleCode: 'DENTIST', clinicId: 'c', branchId: null })).resolves.toBeUndefined();
      await expect(service.assertCanRemove(never, { id: 'x', roleCode: 'CLINIC_ADMIN', clinicId: 'c', branchId: 'b' })).resolves.toBeUndefined();
    });
  });
});
