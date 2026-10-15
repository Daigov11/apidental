import { actorIn, bearer, createPatient, createTestContext, Fixtures, loginInContext, type TestContext, uniq } from './helpers/app.js';
import { addDays, limaToUtc, utcToLima, weekdayOfDate } from '../src/agenda/agenda-time.js';

const GHOST = '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11';

describe('Agenda y citas (4.0)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  /** Fecha (Lima) a 3 días vista y su día de la semana. */
  const futureDate = () => {
    const d = addDays(utcToLima(new Date()).date, 3);
    return { date: d, weekday: weekdayOfDate(d) };
  };
  const at = (date: string, hhmm: string) => limaToUtc(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString();

  async function world() {
    const clinic = await fx.clinic();
    const branchA = await fx.branch(clinic.id);
    const branchB = await fx.branch(clinic.id);
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id });
    const receptionB = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: clinic.id, branchId: branchB.id });
    const dUser = await fx.user();
    await fx.assign(dUser.id, 'DENTIST', { clinicId: clinic.id, branchId: branchA.id }, admin.user.id);
    const dentist = { user: dUser, token: await loginInContext(ctx, dUser.email, { clinicId: clinic.id, branchId: branchA.id }) };
    const d2User = await fx.user();
    await fx.assign(d2User.id, 'DENTIST', { clinicId: clinic.id, branchId: branchA.id }, admin.user.id);
    const post = (t: string, p: string, b: unknown = {}) => ctx.http().post(`/v1${p}`).set(bearer(t)).send(b as object);
    const get = (t: string, p: string) => ctx.http().get(`/v1${p}`).set(bearer(t));
    const room1 = (await post(admin.token, '/agenda/rooms', { branchId: branchA.id, name: 'Consultorio 1' }).expect(201)).body;
    const room2 = (await post(admin.token, '/agenda/rooms', { branchId: branchA.id, name: 'Consultorio 2' }).expect(201)).body;
    const service = (await post(admin.token, '/agenda/services', { name: 'Consulta', durationMinutes: 30 }).expect(201)).body;
    const { date, weekday } = futureDate();
    for (const u of [dUser.id, d2User.id]) {
      await post(admin.token, '/agenda/schedules', { branchId: branchA.id, dentistUserId: u, weekday, start: '08:00', end: '18:00', validFrom: date }).expect(201);
    }
    const patient = (await createPatient(ctx, reception.token, { lastName: uniq('Paciente') })).id;
    const patient2 = (await createPatient(ctx, reception.token, { lastName: uniq('Paciente') })).id;
    const book = (t: string, over: Record<string, unknown> = {}) =>
      post(t, '/appointments', { patientId: patient, branchId: branchA.id, serviceId: service.id, dentistUserId: dUser.id, startsAt: at(date, '10:00'), ...over });
    return { clinic, branchA, branchB, admin, reception, receptionB, dentist, d2User, room1, room2, service, date, patient, patient2, post, get, book };
  }
  const audits = (action: string, entityId: string) => ctx.db.auditLog.findMany({ where: { action, entityId } });

  it('configuración: solo quien gestiona la agenda; nombres únicos por sede', async () => {
    const w = await world();
    await w.post(w.reception.token, '/agenda/rooms', { branchId: w.branchA.id, name: 'Otro' }).expect(403);
    await w.post(w.admin.token, '/agenda/rooms', { branchId: w.branchA.id, name: 'Consultorio 1' }).expect(409);
    await w.post(w.admin.token, '/agenda/services', { name: 'Consulta', durationMinutes: 30 }).expect(409);
    await w.post(w.admin.token, '/agenda/services', { name: 'Raro', durationMinutes: 33 }).expect(400);
    // horarios superpuestos del mismo odontólogo
    const res = await w.post(w.admin.token, '/agenda/schedules', { branchId: w.branchA.id, dentistUserId: w.dentist.user.id, weekday: weekdayOfDate(w.date), start: '17:00', end: '19:00', validFrom: w.date });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SCHEDULE_OVERLAP');
    const rooms = await w.get(w.reception.token, `/agenda/rooms?branchId=${w.branchA.id}`).expect(200);
    expect(rooms.body.map((r: { name: string }) => r.name)).toEqual(['Consultorio 1', 'Consultorio 2']);
  });

  it('disponibilidad: ofrece horarios en la ventana y desaparecen al reservarse', async () => {
    const w = await world();
    const q = `/agenda/availability?branchId=${w.branchA.id}&from=${w.date}&serviceId=${w.service.id}&dentistUserId=${w.dentist.user.id}`;
    const before = (await w.get(w.reception.token, q).expect(200)).body;
    const times = before.slots.map((s: { time: string }) => s.time);
    expect(times[0]).toBe('08:00');
    expect(times).toContain('10:00');
    expect(times).not.toContain('17:45');
    expect(before.slots[0].roomIds).toHaveLength(2);
    await w.book(w.reception.token).expect(201);
    const after = (await w.get(w.reception.token, q).expect(200)).body.slots.map((s: { time: string }) => s.time);
    expect(after).not.toContain('10:00');
    expect(after).not.toContain('09:45'); // la cita de 30 min a las 09:45 pisaría la de las 10:00
    expect(after).toContain('10:30');
    // dos consultorios: aún hay uno libre para otro odontólogo a la misma hora
    const other = (await w.get(w.reception.token, `/agenda/availability?branchId=${w.branchA.id}&from=${w.date}&serviceId=${w.service.id}&dentistUserId=${w.d2User.id}`).expect(200)).body.slots;
    expect(other.find((s: { time: string }) => s.time === '10:00').roomIds).toHaveLength(1);
  });

  it('crear cita: vista en español, sin vínculo clínico para recepción; fuera de horario, pasado y duplicados', async () => {
    const w = await world();
    const res = await w.book(w.reception.token, { notes: 'Llega con su mamá' }).expect(201);
    expect(res.body).toMatchObject({ status: 'RESERVED', statusLabel: 'Reservado', time: '10:00', durationMinutes: 30, notes: 'Llega con su mamá' });
    expect(res.body.visitId).toBeUndefined();
    expect(res.body.actions).toMatchObject({ confirm: true, cancel: true, reschedule: true, startAttention: false });
    expect(res.body.patient.name).toContain('Paciente');
    expect((await audits('APPOINTMENT_CREATED', res.body.id)).length).toBe(1);
    // fuera del horario del odontólogo
    expect((await w.book(w.reception.token, { startsAt: at(w.date, '19:00') })).body.code).toBe('OUTSIDE_SCHEDULE');
    // desalineada a 5 minutos
    await w.book(w.reception.token, { startsAt: new Date(new Date(at(w.date, '11:00')).getTime() + 60_000).toISOString() }).expect(400);
    // pasado
    await w.book(w.reception.token, { startsAt: new Date(Date.now() - 3_600_000 - (Date.now() % 300_000)).toISOString() }).expect(400);
    // mismo odontólogo y hora
    const dup = await w.book(w.reception.token, { patientId: w.patient2 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SLOT_TAKEN');
    // el mismo paciente no puede estar en dos citas a la vez
    const busy = await w.book(w.reception.token, { dentistUserId: w.d2User.id });
    expect(busy.body.code).toBe('PATIENT_BUSY');
    // paciente inexistente / de otra clínica → 404
    await w.book(w.reception.token, { patientId: GHOST, startsAt: at(w.date, '12:00') }).expect(404);
  });

  it('doble reserva concurrente: el odontólogo y el consultorio solo se ocupan una vez', async () => {
    const w = await world();
    // mismo odontólogo, dos pacientes a la vez
    const two = await Promise.all([w.book(w.reception.token, { patientId: w.patient }), w.book(w.reception.token, { patientId: w.patient2 })]);
    expect(two.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(two.find((r) => r.status === 409)!.body.code).toBe('SLOT_TAKEN');
    // dos odontólogos distintos pidiendo el MISMO consultorio a la misma hora
    const p3 = (await createPatient(ctx, w.reception.token, { lastName: uniq('Paciente') })).id;
    const p4 = (await createPatient(ctx, w.reception.token, { lastName: uniq('Paciente') })).id;
    const rooms = await Promise.all([
      w.book(w.reception.token, { patientId: p3, startsAt: at(w.date, '14:00'), roomId: w.room1.id }),
      w.book(w.reception.token, { patientId: p4, startsAt: at(w.date, '14:00'), roomId: w.room1.id, dentistUserId: w.d2User.id }),
    ]);
    expect(rooms.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    // sin consultorio indicado, el sistema reparte entre los dos consultorios
    const p5 = (await createPatient(ctx, w.reception.token, { lastName: uniq('Paciente') })).id;
    const p6 = (await createPatient(ctx, w.reception.token, { lastName: uniq('Paciente') })).id;
    const auto = await Promise.all([
      w.book(w.reception.token, { patientId: p5, startsAt: at(w.date, '15:00') }),
      w.book(w.reception.token, { patientId: p6, startsAt: at(w.date, '15:00'), dentistUserId: w.d2User.id }),
    ]);
    // ambas caben (hay dos consultorios) o una recibe 409 por carrera; nunca dos en el mismo consultorio
    const ok = auto.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    if (ok.length === 2) expect(new Set(ok.map((r) => r.body.room.id)).size).toBe(2);
    // la tabla de huecos no tiene huecos duplicados por recurso (garantía de la BD)
    const dups = await ctx.db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM (SELECT resource_kind, resource_id, slot_start FROM appointment_slots WHERE clinic_id = ${w.clinic.id} GROUP BY 1,2,3 HAVING COUNT(*) > 1) t`;
    expect(Number(dups[0]!.n)).toBe(0);
  });

  it('bloqueos: chocan con citas en ambos sentidos y se liberan con motivo', async () => {
    const w = await world();
    const appt = (await w.book(w.reception.token).expect(201)).body;
    const block = (over: Record<string, unknown>) => w.post(w.admin.token, '/agenda/blocks', { branchId: w.branchA.id, dentistUserId: w.dentist.user.id, startsAt: at(w.date, '10:00'), endsAt: at(w.date, '11:00'), reason: 'Reunión', ...over });
    const clash = await block({});
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_TAKEN');
    await w.post(w.reception.token, '/agenda/blocks', { branchId: w.branchA.id, dentistUserId: w.dentist.user.id, startsAt: at(w.date, '12:00'), endsAt: at(w.date, '13:00'), reason: 'Reunión' }).expect(403);
    const free = (await block({ startsAt: at(w.date, '12:00'), endsAt: at(w.date, '13:00') }).expect(201)).body;
    const blocked = await w.book(w.reception.token, { patientId: w.patient2, startsAt: at(w.date, '12:30') });
    expect(blocked.body.code).toBe('SLOT_TAKEN');
    await w.post(w.admin.token, `/agenda/blocks/${free.id}/release`, { reason: 'x' }).expect(400);
    await w.post(w.admin.token, `/agenda/blocks/${free.id}/release`, { reason: 'Se canceló la reunión' }).expect(200);
    await w.post(w.admin.token, `/agenda/blocks/${free.id}/release`, { reason: 'Se canceló la reunión' }).expect(409);
    await w.book(w.reception.token, { patientId: w.patient2, startsAt: at(w.date, '12:30') }).expect(201);
    // el calendario muestra citas y ventanas
    const cal = (await w.get(w.reception.token, `/agenda/calendar?branchId=${w.branchA.id}&from=${w.date}`).expect(200)).body;
    expect(cal.appointments.map((a: { id: string }) => a.id)).toContain(appt.id);
    expect(cal.windows.length).toBe(2);
    expect(cal.blocks).toHaveLength(0);
  });

  it('transiciones: confirmar, reprogramar, cancelar y ausencia con motivo, versión y auditoría', async () => {
    const w = await world();
    const a = (await w.book(w.reception.token).expect(201)).body;
    const conf = (await w.post(w.reception.token, `/appointments/${a.id}/confirm`, { expectedVersion: a.version }).expect(200)).body;
    expect(conf).toMatchObject({ status: 'CONFIRMED', statusLabel: 'Confirmado', version: a.version + 1 });
    // versión vieja
    const stale = await w.post(w.reception.token, `/appointments/${a.id}/confirm`, { expectedVersion: a.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    // reprogramar: motivo obligatorio; vuelve a Reservado y libera el hueco anterior
    await w.post(w.reception.token, `/appointments/${a.id}/reschedule`, { expectedVersion: conf.version, startsAt: at(w.date, '11:00') }).expect(400);
    const re = (await w.post(w.reception.token, `/appointments/${a.id}/reschedule`, { expectedVersion: conf.version, startsAt: at(w.date, '11:00'), reason: 'Pidió otro horario' }).expect(200)).body;
    expect(re).toMatchObject({ status: 'RESERVED', time: '11:00', rescheduledCount: 1 });
    const log = await audits('APPOINTMENT_RESCHEDULED', a.id);
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0]!.summary)).toContain('Pidió otro horario');
    await w.book(w.reception.token, { patientId: w.patient2 }).expect(201); // 10:00 quedó libre
    // reprogramar sin cambios
    await w.post(w.reception.token, `/appointments/${a.id}/reschedule`, { expectedVersion: re.version, reason: 'Sin cambios' }).expect(400);
    // ausencia antes de la hora
    const early = await w.post(w.reception.token, `/appointments/${a.id}/no-show`, { expectedVersion: re.version, reason: 'No llegó' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('TOO_EARLY');
    // cancelar exige motivo
    await w.post(w.reception.token, `/appointments/${a.id}/cancel`, { expectedVersion: re.version, reason: 'a' }).expect(400);
    const can = (await w.post(w.reception.token, `/appointments/${a.id}/cancel`, { expectedVersion: re.version, reason: 'El paciente avisó' }).expect(200)).body;
    expect(can).toMatchObject({ status: 'CANCELLED', statusLabel: 'Cancelado', cancelReason: 'El paciente avisó' });
    expect(can.actions.reschedule).toBe(false);
    expect((await audits('APPOINTMENT_CANCELLED', a.id)).length).toBe(1);
    // estados terminales: nada más
    for (const [p, b] of [['confirm', {}], ['cancel', { reason: 'otra vez' }], ['reschedule', { reason: 'otra vez', startsAt: at(w.date, '16:00') }]] as const) {
      const r = await w.post(w.reception.token, `/appointments/${a.id}/${p}`, { expectedVersion: can.version, ...b });
      expect(r.status, p).toBe(409);
      expect(r.body.code).toBe('INVALID_TRANSITION');
    }
    // el hueco de las 11:00 quedó libre tras cancelar
    await w.book(w.reception.token, { patientId: w.patient, startsAt: at(w.date, '11:00') }).expect(201);
  });

  it('la base de datos impone las transiciones aunque se salte la API', async () => {
    const w = await world();
    const a = (await w.book(w.reception.token).expect(201)).body;
    await expect(ctx.db.$executeRaw`UPDATE appointments SET status = 'ATTENDED', version = version + 1 WHERE id = ${a.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`UPDATE appointments SET status = 'CANCELLED', version = version + 1 WHERE id = ${a.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`UPDATE appointments SET patient_id = ${w.patient2} WHERE id = ${a.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`DELETE FROM appointments WHERE id = ${a.id}`).rejects.toThrow();
    await expect(ctx.db.$executeRaw`INSERT INTO appointment_slots (resource_kind, resource_id, slot_start, owner_kind, owner_id, clinic_id) VALUES ('DENTIST', ${w.dentist.user.id}, ${new Date(a.startsAt)}, 'APPOINTMENT', ${a.id}, ${w.clinic.id})`).rejects.toThrow();
  });

  it('aislamiento por clínica y por sede: 404 uniforme', async () => {
    const w = await world();
    const a = (await w.book(w.reception.token).expect(201)).body;
    const other = await world();
    for (const r of [await other.get(other.admin.token, `/appointments/${a.id}`), await other.post(other.reception.token, `/appointments/${a.id}/confirm`, { expectedVersion: 1 })]) {
      expect(r.status).toBe(404);
    }
    expect((await other.get(other.admin.token, `/appointments?from=${w.date}&to=${w.date}`).expect(200)).body.map((x: { id: string }) => x.id)).not.toContain(a.id);
    // recepción limitada a la sede B no ve ni opera la sede A
    await w.get(w.receptionB.token, `/appointments/${a.id}`).expect(404);
    await w.post(w.receptionB.token, '/appointments', { patientId: w.patient, branchId: w.branchA.id, serviceId: w.service.id, dentistUserId: w.dentist.user.id, startsAt: at(w.date, '16:00') }).expect(404);
    await w.get(w.receptionB.token, `/agenda/calendar?branchId=${w.branchA.id}&from=${w.date}`).expect(404);
    // un odontólogo de otra clínica no se puede agendar
    await w.book(w.reception.token, { dentistUserId: other.dentist.user.id, startsAt: at(w.date, '16:00') }).expect(404);
    // servicio de otra clínica
    await w.book(w.reception.token, { serviceId: other.service.id, startsAt: at(w.date, '16:00') }).expect(404);
  });

  it('cita → relación asistencial → visita, sin dar acceso clínico a recepción', async () => {
    const w = await world();
    const startsAt = new Date(Math.ceil((Date.now() + 60_000) / 300_000) * 300_000);
    const mk = (createdById: string, patientId = w.patient) =>
      ctx.db.appointment.create({
        data: { clinicId: w.clinic.id, branchId: w.branchA.id, patientId, dentistUserId: w.dentist.user.id, roomId: w.room1.id, serviceId: w.service.id, startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), createdById },
      });
    // recepción no inicia atenciones ni ve datos clínicos
    const row = await mk(w.reception.user.id);
    await w.post(w.reception.token, `/appointments/${row.id}/start-attention`).expect(403);
    await w.get(w.reception.token, `/patients/${w.patient}/clinical/visits`).expect(403);
    // otro odontólogo no inicia la atención ajena
    const d2 = await loginInContext(ctx, w.d2User.email, { clinicId: w.clinic.id, branchId: w.branchA.id });
    await w.post(d2, `/appointments/${row.id}/start-attention`).expect(403);
    // aún sin relación: el odontólogo no ve al paciente
    await w.get(w.dentist.token, `/patients/${w.patient}/clinical/visits`).expect(403);

    const res = await w.post(w.dentist.token, `/appointments/${row.id}/start-attention`).expect(200);
    expect(res.body.appointment).toMatchObject({ status: 'ATTENDED', statusLabel: 'Atendido', hasVisit: true });
    expect(res.body.visit.number).toBe(1);
    expect(res.body.alreadyStarted).toBe(false);
    const rel = await ctx.db.patientCareRelationship.findFirstOrThrow({ where: { patientId: w.patient, dentistUserId: w.dentist.user.id } });
    expect(rel).toMatchObject({ source: 'APPOINTMENT', sourceRef: row.id, status: 'ACTIVE', branchId: w.branchA.id, createdById: w.reception.user.id });
    expect(rel.validUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const visit = await ctx.db.clinicalVisit.findUniqueOrThrow({ where: { id: res.body.visit.id } });
    expect(visit).toMatchObject({ appointmentId: row.id, careRelationshipId: rel.id, status: 'OPEN' });
    for (const action of ['APPOINTMENT_ATTENDED', 'CARE_RELATIONSHIP_CREATED', 'CLINICAL_VISIT_OPENED']) expect((await ctx.db.auditLog.findMany({ where: { action, patientId: w.patient } })).length, action).toBe(1);

    // idempotente
    const again = await w.post(w.dentist.token, `/appointments/${row.id}/start-attention`).expect(200);
    expect(again.body.alreadyStarted).toBe(true);
    expect(again.body.visit.id).toBe(res.body.visit.id);
    // el odontólogo ve la ficha; recepción sigue sin acceso (ficha, evolución, odontograma)
    await w.get(w.dentist.token, `/patients/${w.patient}/clinical/visits/${res.body.visit.id}/sheet`).expect(200);
    for (const p of ['visits', `visits/${res.body.visit.id}/sheet`, 'odontogram', `visits/${res.body.visit.id}/evolution`, 'diagnoses']) {
      expect((await w.get(w.reception.token, `/patients/${w.patient}/clinical/${p}`)).status, p).toBe(403);
    }
    // recepción ve la cita sin el vínculo con la visita
    const seen = (await w.get(w.reception.token, `/appointments/${row.id}`).expect(200)).body;
    expect(seen.visitId).toBeUndefined();
    expect(seen.hasVisit).toBe(true);
    expect((await w.get(w.dentist.token, `/appointments/${row.id}`).expect(200)).body.visitId).toBe(res.body.visit.id);
    // una cita atendida no se cancela
    expect((await w.post(w.reception.token, `/appointments/${row.id}/cancel`, { expectedVersion: again.body.appointment.version, reason: 'Ya se atendió' })).status).toBe(409);
  });

  it('separación de funciones: quien otorgó el rol al odontólogo no puede ser quien agenda su cita', async () => {
    const w = await world();
    const startsAt = new Date(Math.ceil((Date.now() + 60_000) / 300_000) * 300_000);
    // la cita la creó el administrador que otorgó el rol DENTIST al odontólogo
    const row = await ctx.db.appointment.create({
      data: { clinicId: w.clinic.id, branchId: w.branchA.id, patientId: w.patient, dentistUserId: w.dentist.user.id, roomId: w.room1.id, serviceId: w.service.id, startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), createdById: w.admin.user.id },
    });
    const res = await w.post(w.dentist.token, `/appointments/${row.id}/start-attention`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEPARATION_OF_DUTIES');
    expect(await ctx.db.patientCareRelationship.count({ where: { patientId: w.patient } })).toBe(0);
    expect(await ctx.db.clinicalVisit.count({ where: { patientId: w.patient } })).toBe(0);
    expect((await ctx.db.auditLog.findMany({ where: { action: 'ESCALATION_BLOCKED', entityId: row.id } })).length).toBe(1);
    // si otra persona la confirma, ya puede iniciarse
    await ctx.db.appointment.update({ where: { id: row.id }, data: { status: 'CONFIRMED', confirmedById: w.reception.user.id, confirmedAt: new Date(), version: 2 } });
    await w.post(w.dentist.token, `/appointments/${row.id}/start-attention`).expect(200);
  });

  it('inicio de atención: fuera de la ventana de tiempo o con visita abierta se rechaza', async () => {
    const w = await world();
    const future = (await w.book(w.reception.token).expect(201)).body;
    const early = await w.post(w.dentist.token, `/appointments/${future.id}/start-attention`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('TOO_EARLY');
    // visita ya abierta con el mismo paciente → 409 y la cita sigue sin atender
    const now = new Date(Math.ceil((Date.now() + 60_000) / 300_000) * 300_000);
    const mk = (patientId: string) => ctx.db.appointment.create({ data: { clinicId: w.clinic.id, branchId: w.branchA.id, patientId, dentistUserId: w.dentist.user.id, roomId: w.room2.id, serviceId: w.service.id, startsAt: now, endsAt: new Date(now.getTime() + 1_800_000), createdById: w.reception.user.id } });
    const a1 = await mk(w.patient2);
    await w.post(w.dentist.token, `/appointments/${a1.id}/start-attention`).expect(200);
    const a2 = await mk(w.patient2);
    const dup = await w.post(w.dentist.token, `/appointments/${a2.id}/start-attention`);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('VISIT_ALREADY_OPEN');
    expect((await ctx.db.appointment.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe('RESERVED');
  });
});
