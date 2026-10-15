import { createTestContext, Fixtures, recoveryReq, settleRecoveries, type TestContext } from './helpers/app.js';

// Enfriamiento por cuenta activo (60 s, el valor por defecto): las demás pruebas lo desactivan.
process.env['PASSWORD_RECOVERY_COOLDOWN_SECONDS'] = '60';

describe('Recuperación de contraseña: enfriamiento por cuenta', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  it('una segunda solicitud dentro del enfriamiento se ignora en silencio (misma respuesta, un solo registro)', async () => {
    const user = await fx.user();
    const first = await recoveryReq(ctx, user.email).expect(202);
    await settleRecoveries(ctx);
    const second = await recoveryReq(ctx, user.email).expect(202);
    await settleRecoveries(ctx);
    expect(second.body).toEqual(first.body);
    expect(await ctx.db.passwordRecovery.count({ where: { userId: user.id } })).toBe(1);
  });

  it('el enfriamiento es por cuenta: otra cuenta no se ve afectada', async () => {
    const a = await fx.user();
    const b = await fx.user();
    await recoveryReq(ctx, a.email).expect(202);
    await settleRecoveries(ctx);
    await recoveryReq(ctx, b.email).expect(202);
    await settleRecoveries(ctx);
    expect(await ctx.db.passwordRecovery.count({ where: { userId: { in: [a.id, b.id] } } })).toBe(2);
  });

  it('pasado el enfriamiento se permite una nueva (revocando la anterior)', async () => {
    const user = await fx.user();
    await recoveryReq(ctx, user.email).expect(202);
    await settleRecoveries(ctx);
    // se adelanta el reloj más allá del enfriamiento (solo Date)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      await recoveryReq(ctx, user.email).expect(202);
      await settleRecoveries(ctx);
    } finally {
      vi.useRealTimers();
    }
    const rows = await ctx.db.passwordRecovery.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['REVOKED', 'PENDING']);
  });
});
