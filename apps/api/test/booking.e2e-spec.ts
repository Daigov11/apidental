import { createPrismaClient } from '../src/prisma/client.js';
import { addDays, limaToUtc, utcToLima, weekdayOfDate } from '../src/agenda/agenda-time.js';
import { actorIn, bearer, createPatient, createTestContext, Fixtures, mobile, type TestContext, uniq } from './helpers/app.js';

/** Solicitudes de cita desde la web pública (incremento 5). */
describe('Web pública: solicitudes de cita (5)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  let clinicId: string;
  let w: Awaited<ReturnType<typeof world>>;

  const at = (date: string, hhmm: string) => limaToUtc(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
  const date = addDays(utcToLima(new Date()).date, 3);
  const pub = (path: string) => ctx.http().get(`/v1/public/booking${path}`);
  const send = (body: Record<string, unknown>) => ctx.http().post('/v1/public/booking/requests').send(body);

  async function world() {
    const clinic = await fx.clinic(uniq('Clínica Pública '));
    const branch = await fx.branch(clinic.id, 'Sede Centro');
    const otherBranch = await fx.branch(clinic.id, 'Sede Norte');
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const receptionNorte = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id, branchId: otherBranch.id });
    const dentistUser = await fx.user();
    await fx.assign(dentistUser.id, 'DENTIST', { clinicId: clinic.id, branchId: branch.id }, admin.user.id);
    const dentistAssist = await actorIn(ctx, fx, 'DENTIST', { clinicId: clinic.id, branchId: branch.id });
    const post = (t: string, p: string, b: unknown = {}) => ctx.http().post(`/v1${p}`).set(bearer(t)).send(b as object);
    const get = (t: string, p: string) => ctx.http().get(`/v1${p}`).set(bearer(t));
    await post(admin.token, '/agenda/rooms', { branchId: branch.id, name: 'Consultorio 1' }).expect(201);
    const service = (await post(admin.token, '/agenda/services', { name: 'Limpieza', durationMinutes: 30, priceCents: 8000 }).expect(201)).body;
    const free = (await post(admin.token, '/agenda/services', { name: 'Evaluación', durationMinutes: 30 }).expect(201)).body;
    await post(admin.token, '/agenda/schedules', { branchId: branch.id, dentistUserId: dentistUser.id, weekday: weekdayOfDate(date), start: '09:00', end: '12:00', validFrom: date }).expect(201);
    return { clinic, branch, otherBranch, admin, reception, receptionNorte, dentistUser, dentistAssist, service, free, post, get };
  }

  beforeAll(async () => {
    // La clínica pública se fija por entorno: se crea antes de arrancar la aplicación.
    const db = createPrismaClient(process.env['DATABASE_URL']!, 2);
    const clinic = await new Fixtures(db).clinic(uniq('Clínica Pública '));
    clinicId = clinic.id;
    await db.$disconnect();
    process.env['PUBLIC_BOOKING_CLINIC_ID'] = clinicId;
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
    // Reutiliza esa clínica en el mundo de pruebas.
    const original = fx.clinic.bind(fx);
    fx.clinic = (() => ctx.db.clinic.findUniqueOrThrow({ where: { id: clinicId } })) as typeof original;
    w = await world();
  });
  afterAll(async () => {
    delete process.env['PUBLIC_BOOKING_CLINIC_ID'];
    await ctx.close();
  });

  const body = (over: Record<string, unknown> = {}) => ({
    branchId: w.branch.id, serviceId: w.service.id, date, time: '10:00', firstName: 'Ana', lastName: 'Quispe', mobile: mobile(), acceptPrivacy: true, ...over,
  });

  it('info: nombre de la clínica, sedes y servicios con duración y precio; sin datos de personas', async () => {
    const res = await pub('/info').expect(200);
    expect(res.body.clinic.name).toContain('Clínica Pública');
    expect(res.body.branches.map((b: { name: string }) => b.name)).toEqual(['Sede Centro', 'Sede Norte']);
    expect(res.body.services).toEqual(expect.arrayContaining([
      { id: w.service.id, name: 'Limpieza', durationMinutes: 30, priceText: 'S/ 80.00' },
      { id: w.free.id, name: 'Evaluación', durationMinutes: 30, priceText: null },
    ]));
    expect(JSON.stringify(res.body)).not.toMatch(/dentist|patient|email|passwordHash/i);
  });

  it('disponibilidad: horas por día (sin odontólogos), con margen mínimo; las ocupadas desaparecen', async () => {
    const res = await pub(`/availability?branchId=${w.branch.id}&serviceId=${w.service.id}&from=${date}&to=${date}`).expect(200);
    expect(res.body.durationMinutes).toBe(30);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.days[0].date).toBe(date);
    expect(res.body.days[0].times.slice(0, 3)).toEqual(['09:00', '09:15', '09:30']);
    expect(res.body.days[0].times).not.toContain('11:45'); // la cita de 30 min no cabe antes de las 12:00
    expect(JSON.stringify(res.body)).not.toMatch(/dentist|roomIds|startsAt/i);
    // Un odontólogo con una cita a las 10:00 deja ese horario sin ofrecer
    const patient = await createPatient(ctx, w.reception.token, { lastName: uniq('Paciente') });
    await w.post(w.reception.token, '/appointments', { patientId: patient.id, branchId: w.branch.id, serviceId: w.service.id, dentistUserId: w.dentistUser.id, startsAt: at(date, '10:00').toISOString() }).expect(201);
    const after = (await pub(`/availability?branchId=${w.branch.id}&serviceId=${w.service.id}&from=${date}`).expect(200)).body.days[0].times;
    expect(after).not.toContain('10:00');
    expect(after).not.toContain('09:45');
    expect(after).toContain('10:30');
    // Rango largo se recorta; fechas pasadas se ajustan a hoy
    const wide = await pub(`/availability?branchId=${w.branch.id}&serviceId=${w.service.id}&from=2020-01-01&to=2030-01-01`).expect(200);
    expect(wide.body.days.every((d: { date: string }) => d.date >= utcToLima(new Date()).date)).toBe(true);
    await pub(`/availability?branchId=${w.branch.id}&serviceId=not-a-uuid&from=${date}`).expect(400);
  });

  it('crear solicitud: guarda una solicitud pendiente y NO crea paciente ni cita', async () => {
    const patientsBefore = await ctx.db.patient.count({ where: { clinicId } });
    const apptsBefore = await ctx.db.appointment.count({ where: { clinicId } });
    const m = mobile();
    const res = await send(body({ mobile: `+51 ${m.slice(0, 3)} ${m.slice(3, 6)} ${m.slice(6)}`, time: '11:00', documentType: 'DNI', documentNumber: '71234567', email: 'ANA@Correo.PE', notes: 'Prefiero por la mañana' })).expect(201);
    expect(res.body.reference).toMatch(/^SOL-[A-Z2-9]{6}$/);
    expect(Object.keys(res.body)).toEqual(['reference']); // no devuelve datos
    const row = await ctx.db.bookingRequest.findUniqueOrThrow({ where: { reference: res.body.reference } });
    expect(row).toMatchObject({ status: 'PENDING', mobile: m, email: 'ana@correo.pe', documentType: 'DNI', documentNumber: '71234567', clinicId, firstName: 'Ana' });
    expect(row.desiredStartsAt.toISOString()).toBe(at(date, '11:00').toISOString());
    expect(row.privacyAcceptedAt).toBeInstanceOf(Date);
    expect(await ctx.db.patient.count({ where: { clinicId } })).toBe(patientsBefore);
    expect(await ctx.db.appointment.count({ where: { clinicId } })).toBe(apptsBefore);
    expect((await ctx.db.auditLog.findMany({ where: { action: 'BOOKING_REQUEST_CREATED', entityId: row.id } })).length).toBe(1);
    // Repetir la misma solicitud devuelve la existente (doble clic)
    const again = await send(body({ mobile: m, time: '11:00' })).expect(201);
    expect(again.body.reference).toBe(res.body.reference);
  });

  it('validaciones y rechazos: privacidad, celular, horario ocupado, señuelo', async () => {
    expect((await send(body({ acceptPrivacy: false }))).status).toBe(400);
    const badMobile = await send(body({ mobile: '12345' }));
    expect(badMobile.status).toBe(400);
    const taken = await send(body({ time: '10:00' })); // ocupado por la cita del otro caso
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SLOT_UNAVAILABLE');
    const before = await ctx.db.bookingRequest.count({ where: { clinicId } });
    const bot = await send(body({ website: 'http://spam.example' })); // señuelo: responde bien pero no guarda
    expect(bot.status).toBe(201);
    expect(await ctx.db.bookingRequest.count({ where: { clinicId } })).toBe(before);
  });

  it('límite de solicitudes pendientes por celular', async () => {
    const m = mobile();
    for (const time of ['09:00', '09:30', '11:30']) {
      await ctx.db.bookingRequest.create({ data: { reference: uniq('SOL-').slice(0, 12), clinicId, branchId: w.branch.id, serviceId: w.service.id, desiredStartsAt: at(date, time), firstName: 'X', lastName: 'Y', mobile: m, privacyAcceptedAt: new Date() } });
    }
    const res = await send(body({ mobile: m, time: '09:15' }));
    expect(res.status).toBe(429);
  });

  it('personal: solo con permiso de gestionar citas; lista, cuenta y alcance por sede', async () => {
    await w.get(w.dentistAssist.token, '/booking-requests').expect(403);
    await ctx.http().get('/v1/booking-requests').expect(401);
    const list = (await w.get(w.reception.token, '/booking-requests').expect(200)).body;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]).toMatchObject({ status: 'PENDING', statusLabel: 'Pendiente' });
    expect(list[0].person.firstName).toBeTruthy();
    const count = (await w.get(w.reception.token, '/booking-requests/count').expect(200)).body.pending;
    expect(count).toBe(list.length);
    // recepción de otra sede no ve las solicitudes de la sede Centro
    expect((await w.get(w.receptionNorte.token, '/booking-requests').expect(200)).body).toHaveLength(0);
  });

  it('atender: crea la cita con el flujo normal y marca la solicitud; no se atiende dos veces', async () => {
    const m = mobile();
    const req = await ctx.db.bookingRequest.create({ data: { reference: 'SOL-ATENDE', clinicId, branchId: w.branch.id, serviceId: w.service.id, desiredStartsAt: at(date, '11:00'), firstName: 'Luz', lastName: 'Rojas', mobile: m, privacyAcceptedAt: new Date() } });
    const patient = await createPatient(ctx, w.reception.token, { lastName: uniq('Paciente') });
    const res = await w.post(w.reception.token, `/booking-requests/${req.id}/accept`, { patientId: patient.id, dentistUserId: w.dentistUser.id, startsAt: at(date, '11:00').toISOString() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'RESERVED', time: '11:00', notes: 'Solicitud web SOL-ATENDE' });
    const row = await ctx.db.bookingRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row).toMatchObject({ status: 'ACCEPTED', appointmentId: res.body.id, patientId: patient.id });
    expect(row.decidedById).toBeTruthy();
    expect((await w.post(w.reception.token, `/booking-requests/${req.id}/accept`, { patientId: patient.id, dentistUserId: w.dentistUser.id, startsAt: at(date, '11:30').toISOString() })).status).toBe(409);
    expect((await w.post(w.reception.token, `/booking-requests/${req.id}/reject`, { reason: 'Ya atendida' })).status).toBe(409);
  });

  it('atender con el horario ocupado: la solicitud sigue pendiente', async () => {
    const req = await ctx.db.bookingRequest.create({ data: { reference: 'SOL-OCUPADO', clinicId, branchId: w.branch.id, serviceId: w.service.id, desiredStartsAt: at(date, '10:00'), firstName: 'Mia', lastName: 'Paz', mobile: mobile(), privacyAcceptedAt: new Date() } });
    const patient = await createPatient(ctx, w.reception.token, { lastName: uniq('Paciente') });
    const res = await w.post(w.reception.token, `/booking-requests/${req.id}/accept`, { patientId: patient.id, dentistUserId: w.dentistUser.id, startsAt: at(date, '10:00').toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SLOT_TAKEN');
    expect(await ctx.db.bookingRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ status: 'PENDING', appointmentId: null, patientId: null });
  });

  it('rechazar: exige motivo y queda registrado', async () => {
    const req = await ctx.db.bookingRequest.create({ data: { reference: 'SOL-RECHAZA', clinicId, branchId: w.branch.id, serviceId: w.service.id, desiredStartsAt: at(date, '09:30'), firstName: 'Teo', lastName: 'Gil', mobile: mobile(), privacyAcceptedAt: new Date() } });
    expect((await w.post(w.reception.token, `/booking-requests/${req.id}/reject`, { reason: 'x' })).status).toBe(400);
    const res = await w.post(w.reception.token, `/booking-requests/${req.id}/reject`, { reason: 'No hay horarios para ese servicio' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', statusLabel: 'Rechazada', rejectReason: 'No hay horarios para ese servicio' });
    const rejected = (await w.get(w.reception.token, '/booking-requests?status=REJECTED').expect(200)).body;
    expect(rejected.map((r: { reference: string }) => r.reference)).toContain('SOL-RECHAZA');
    expect((await ctx.db.auditLog.findMany({ where: { action: 'BOOKING_REQUEST_REJECTED', entityId: req.id } })).length).toBe(1);
    // no se puede atender una solicitud de otra sede si el actor está limitado a una
    expect((await w.post(w.receptionNorte.token, `/booking-requests/${req.id}/reject`, { reason: 'Intento ajeno' })).status).toBe(404);
  });
});

describe('Web pública apagada por defecto', () => {
  it('sin PUBLIC_BOOKING_CLINIC_ID las rutas públicas responden 404', async () => {
    delete process.env['PUBLIC_BOOKING_CLINIC_ID'];
    const ctx = await createTestContext();
    try {
      await ctx.http().get('/v1/public/booking/info').expect(404);
    } finally {
      await ctx.close();
    }
  });
});
