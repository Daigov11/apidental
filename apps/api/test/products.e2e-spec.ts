import { matchProduct } from '../src/products/products.js';
import { bearer, createTestContext, Fixtures, loginInContext, type TestContext } from './helpers/app.js';

describe('Catálogo de productos', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function setup() {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const admin = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: a.id })).user;
    const token = await loginInContext(ctx, admin.email, { clinicId: a.id });
    return { a, b, token };
  }

  it('el administrador crea, edita y desactiva productos; la lista normal solo muestra los activos', async () => {
    const t = await setup();
    const created = await ctx.http().post('/v1/products').set(bearer(t.token)).send({ name: '  Amoxicilina   500 mg ', presentation: 'caja x 21', priceCents: 2500 }).expect(201);
    expect(created.body).toMatchObject({ name: 'Amoxicilina 500 mg', presentation: 'caja x 21', priceCents: 2500, active: true });
    await ctx.http().post('/v1/products').set(bearer(t.token)).send({ name: 'Amoxicilina 500 mg', priceCents: 100 }).expect(409);
    await ctx.http().post('/v1/products').set(bearer(t.token)).send({ name: 'X', priceCents: 0 }).expect(400);

    const upd = await ctx.http().patch(`/v1/products/${created.body.id}`).set(bearer(t.token)).send({ priceCents: 2800 }).expect(200);
    expect(upd.body.priceCents).toBe(2800);
    const audit = await ctx.db.auditLog.findFirstOrThrow({ where: { action: 'PRODUCT_UPDATED', entityId: created.body.id } });
    expect(audit.summary).toMatchObject({ priceCents: { from: 2500, to: 2800 } });

    await ctx.http().patch(`/v1/products/${created.body.id}`).set(bearer(t.token)).send({ active: false }).expect(200);
    expect((await ctx.http().get('/v1/products').set(bearer(t.token)).expect(200)).body).toEqual([]);
    expect((await ctx.http().get('/v1/products?all=1').set(bearer(t.token)).expect(200)).body).toHaveLength(1);
  });

  it('cada clínica tiene su catálogo; quien solo atiende lo consulta pero no lo modifica', async () => {
    const t = await setup();
    const p = await ctx.http().post('/v1/products').set(bearer(t.token)).send({ name: 'Ibuprofeno 400 mg', priceCents: 800 }).expect(201);
    const otherAdmin = (await fx.userWithRole('CLINIC_ADMIN', { clinicId: t.b.id })).user;
    const other = await loginInContext(ctx, otherAdmin.email, { clinicId: t.b.id });
    expect((await ctx.http().get('/v1/products').set(bearer(other)).expect(200)).body).toEqual([]);
    await ctx.http().patch(`/v1/products/${p.body.id}`).set(bearer(other)).send({ priceCents: 1 }).expect(404);

    const dentist = (await fx.userWithRole('DENTIST', { clinicId: t.a.id })).user;
    const dt = await loginInContext(ctx, dentist.email, { clinicId: t.a.id });
    expect((await ctx.http().get('/v1/products').set(bearer(dt)).expect(200)).body.map((x: { name: string }) => x.name)).toEqual(['Ibuprofeno 400 mg']);
    await ctx.http().post('/v1/products').set(bearer(dt)).send({ name: 'Otro', priceCents: 100 }).expect(403);
    await ctx.http().patch(`/v1/products/${p.body.id}`).set(bearer(dt)).send({ priceCents: 1 }).expect(403);
  });

  it('empareja el medicamento recetado con el catálogo: con dosis primero, sin tildes ni mayúsculas', () => {
    const cat = [
      { id: '1', name: 'Amoxicilina', presentation: null, priceCents: 1000, active: true },
      { id: '2', name: 'AMOXICILINA 500 MG', presentation: null, priceCents: 2500, active: true },
      { id: '3', name: 'Clorhexidina 0.12%', presentation: null, priceCents: 1500, active: true },
    ];
    expect(matchProduct(cat, 'amoxicilina', '500 mg')?.id).toBe('2');
    expect(matchProduct(cat, 'Amoxicilina', null)?.id).toBe('1');
    expect(matchProduct(cat, 'Amoxicilína', '250 mg')?.id).toBe('1');
    expect(matchProduct(cat, 'Clorhexidina 0.12%', null)?.id).toBe('3');
    expect(matchProduct(cat, 'Paracetamol', '500 mg')).toBeNull();
  });
});
