import { createTestContext, Fixtures, type TestContext } from './helpers/app.js';

describe('Garantías de la base de datos', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  it('audit_logs es inmutable: UPDATE y DELETE son rechazados por la base', async () => {
    const row = await ctx.db.auditLog.create({ data: { action: 'TEST', entity: 'Test' } });
    await expect(ctx.db.auditLog.update({ where: { id: row.id }, data: { action: 'X' } })).rejects.toThrow(/inmutable/);
    await expect(ctx.db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/inmutable/);
    await expect(ctx.db.auditLog.deleteMany({})).rejects.toThrow(/inmutable/);
    expect(await ctx.db.auditLog.count({ where: { id: row.id } })).toBe(1);
  });

  it('una asignación con sede exige clínica (CHECK)', async () => {
    const clinic = await fx.clinic();
    const branch = await fx.branch(clinic.id);
    const user = await fx.user();
    const role = await ctx.db.role.findUniqueOrThrow({ where: { code: 'DENTIST' } });
    await expect(
      ctx.db.userAssignment.create({ data: { userId: user.id, roleId: role.id, branchId: branch.id, clinicId: null, assignmentKey: 'chk-1' } }),
    ).rejects.toThrow();
  });

  it('una sede no puede asignarse con la clínica equivocada (FK compuesta)', async () => {
    const own = await fx.clinic();
    const foreign = await fx.clinic();
    const branch = await fx.branch(own.id);
    const user = await fx.user();
    const role = await ctx.db.role.findUniqueOrThrow({ where: { code: 'DENTIST' } });
    await expect(
      ctx.db.userAssignment.create({ data: { userId: user.id, roleId: role.id, clinicId: foreign.id, branchId: branch.id, assignmentKey: 'fk-1' } }),
    ).rejects.toThrow();
  });

  it('no permite asignaciones duplicadas (assignmentKey único, incluso con columnas NULL)', async () => {
    const user = await fx.user();
    await fx.assign(user.id, 'PLATFORM_ADMIN');
    await expect(fx.assign(user.id, 'PLATFORM_ADMIN')).rejects.toThrow();
  });

  it('el correo y el RUC son únicos', async () => {
    const user = await fx.user();
    await expect(fx.user({ email: user.email })).rejects.toThrow();
    await ctx.db.clinic.create({ data: { name: 'R1', ruc: '20100000001' } });
    await expect(ctx.db.clinic.create({ data: { name: 'R2', ruc: '20100000001' } })).rejects.toThrow();
    await ctx.db.clinic.create({ data: { name: 'R3' } });
    await ctx.db.clinic.create({ data: { name: 'R4' } }); // varios sin RUC son válidos
  });

  it('passwordHash queda excluido por defecto en cualquier consulta de User', async () => {
    const user = await fx.user();
    const found = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect('passwordHash' in found).toBe(false);
    const withHash = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id }, omit: { passwordHash: false } });
    expect(withHash.passwordHash).toContain('$argon2id$');
  });
});
