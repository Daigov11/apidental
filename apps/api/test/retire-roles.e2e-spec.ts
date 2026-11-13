import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bearer, createTestContext, Fixtures, loginInContext, uniq, type TestContext } from './helpers/app.js';

const MIGRATION = join(__dirname, '../prisma/migrations/20261112230000_retire_roles/migration.sql');
/** Sentencias de la migración (sin comentarios), para ejecutarlas sobre datos de prueba. */
const statements = () =>
  readFileSync(MIGRATION, 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);

class Rollback extends Error {}

describe('Roles retirados: solo Administrador, Cajero y Odontólogo', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  it('la migración pasa Recepcionista a Cajero y desactiva Asistente y Director (sin duplicar a quien ya era Cajero)', async () => {
    const clinic = await fx.clinic();
    const recep = (await fx.userWithRole('RECEPTIONIST', { clinicId: clinic.id })).user;
    const both = (await fx.userWithRole('RECEPTIONIST', { clinicId: clinic.id })).user;
    await fx.userWithRole('CASHIER', { clinicId: clinic.id }).then(() => undefined);
    const cashierRole = await ctx.db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    await ctx.db.userAssignment.create({ data: { userId: both.id, roleId: cashierRole.id, clinicId: clinic.id, assignmentKey: `${both.id}|${cashierRole.id}|${clinic.id}|*` } });
    const assistant = (await fx.userWithRole('ASSISTANT', { clinicId: clinic.id })).user;
    const director = (await fx.userWithRole('CLINICAL_DIRECTOR', { clinicId: clinic.id })).user;
    const dentist = (await fx.userWithRole('DENTIST', { clinicId: clinic.id })).user;

    const roles = (userId: string, db: typeof ctx.db) =>
      db.userAssignment.findMany({ where: { userId, clinicId: clinic.id }, select: { status: true, role: { select: { code: true } } } })
        .then((r) => r.map((a) => `${a.role.code}:${a.status}`).sort());

    await expect(ctx.db.$transaction(async (tx) => {
      for (const sql of statements()) await tx.$executeRawUnsafe(sql);
      const t = tx as unknown as typeof ctx.db;
      expect(await roles(recep.id, t)).toEqual(['CASHIER:ACTIVE']);
      expect(await roles(both.id, t)).toEqual(['CASHIER:ACTIVE', 'RECEPTIONIST:INACTIVE']);
      expect(await roles(assistant.id, t)).toEqual(['ASSISTANT:INACTIVE']);
      expect(await roles(director.id, t)).toEqual(['CLINICAL_DIRECTOR:INACTIVE']);
      expect(await roles(dentist.id, t)).toEqual(['DENTIST:ACTIVE']);
      // La clave única sigue el formato de la aplicación.
      const converted = await t.userAssignment.findFirstOrThrow({ where: { userId: recep.id } });
      expect(converted.assignmentKey).toBe(`${recep.id}|${cashierRole.id}|${clinic.id}|*`);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    // Nada quedó aplicado fuera de la transacción.
    expect(await roles(recep.id, ctx.db)).toEqual(['RECEPTIONIST:ACTIVE']);
  });

  it('los roles retirados no se asignan ni se crean usuarios con ellos; la lista los marca como retirados', async () => {
    const clinic = await fx.clinic();
    const admin = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id })).user;
    const token = await loginInContext(ctx, admin.email, { clinicId: clinic.id });
    const target = (await fx.userWithRole('DENTIST', { clinicId: clinic.id })).user;
    for (const roleCode of ['RECEPTIONIST', 'ASSISTANT', 'CLINICAL_DIRECTOR']) {
      await ctx.http().post('/v1/assignments').set(bearer(token)).send({ userId: target.id, roleCode }).expect(403);
      await ctx.http().post('/v1/users').set(bearer(token)).send({ email: `${uniq('x')}@test.pe`, firstName: 'A', lastName: 'B', roleCode }).expect(403);
    }
    await ctx.http().post('/v1/assignments').set(bearer(token)).send({ userId: target.id, roleCode: 'CASHIER' }).expect(201);
    const roles = (await ctx.http().get('/v1/roles').set(bearer(token)).expect(200)).body as { code: string; retired: boolean }[];
    expect(roles.filter((r) => !r.retired).map((r) => r.code).sort()).toEqual(['CASHIER', 'CLINIC_ADMIN', 'DENTIST']);
  });

  it('el cajero agenda: puede ver y gestionar citas y registrar pacientes', async () => {
    const clinic = await fx.clinic();
    const cashier = (await fx.userWithRole('CASHIER', { clinicId: clinic.id })).user;
    const token = await loginInContext(ctx, cashier.email, { clinicId: clinic.id });
    const me = (await ctx.http().get('/v1/auth/me').set(bearer(token)).expect(200)).body as { permissions: string[] };
    expect(me.permissions).toEqual(expect.arrayContaining(['appointment:manage', 'patient:write']));
    expect(me.permissions.filter((p) => p.startsWith('clinical:') || p === 'care:assign')).toEqual([]);
    expect(me.permissions).not.toContain('appointment:attend');
  });
});
