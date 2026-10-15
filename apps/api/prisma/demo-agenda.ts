import { addMinutes, slotStarts, limaToUtc, utcToLima, addDays } from '../src/agenda/agenda-time.js';
import type { PrismaDb } from '../src/prisma/client.js';

/**
 * AGENDA DE DEMOSTRACIÓN de Clínica Demo (todo ficticio): consultorios, especialidad, servicios, horario de la
 * odontóloga demo y citas de ejemplo para ayer, hoy, mañana y pasado mañana, con los pacientes Demo. Idempotente:
 * si ya hay citas de demostración vigentes no vuelve a crearlas. Solo desarrollo.
 *
 * Citas de ejemplo (creadas por recepción demo, que NO es quien otorgó el rol a la odontóloga):
 *  - hoy, Camila Demo Nueva (sin visitas previas): lista para "Iniciar atención" y ver el flujo cita → visita → odontograma.
 *  - hoy, más tarde: Lucía Demo (confirmada).
 *  - mañana: Mateo Demo (reservada); pasado mañana: Jorge Demo (reservada); una cita cancelada y una ausencia de ayer.
 */
export const DEMO_APPT_NOTE = 'Demo:';

interface Ctx {
  clinicId: string;
  branchId: string;
  dentistId: string;
  receptionId: string;
  adminUserId: string;
}

export async function seedDemoAgenda(db: PrismaDb, c: Ctx): Promise<{ rooms: number; services: number; appointments: number }> {
  const { clinicId, branchId, dentistId, receptionId, adminUserId } = c;

  const rooms: string[] = [];
  for (const name of ['Consultorio 1 (demo)', 'Consultorio 2 (demo)']) {
    const room = (await db.room.findUnique({ where: { branchId_name: { branchId, name } } })) ?? (await db.room.create({ data: { clinicId, branchId, name } }));
    rooms.push(room.id);
  }
  const specialty = (await db.specialty.findUnique({ where: { clinicId_name: { clinicId, name: 'Odontología general (demo)' } } })) ?? (await db.specialty.create({ data: { clinicId, name: 'Odontología general (demo)' } }));
  await db.dentistSpecialty.upsert({
    where: { userId_specialtyId: { userId: dentistId, specialtyId: specialty.id } },
    update: {},
    create: { clinicId, userId: dentistId, specialtyId: specialty.id },
  });
  const services: Record<string, { id: string; minutes: number }> = {};
  for (const [name, minutes] of [['Consulta (demo)', 30], ['Limpieza dental (demo)', 45], ['Control (demo)', 20], ['Restauración (demo)', 60]] as const) {
    const s = (await db.agendaService.findUnique({ where: { clinicId_name: { clinicId, name } } })) ?? (await db.agendaService.create({ data: { clinicId, name, durationMinutes: minutes, specialtyId: specialty.id } }));
    services[name] = { id: s.id, minutes };
  }
  // La clínica demo atiende todos los días de 08:00 a 18:00 (solo para que la demostración funcione cualquier día).
  const today = utcToLima(new Date()).date;
  if ((await db.scheduleRule.count({ where: { clinicId, dentistUserId: dentistId, status: 'ACTIVE' } })) === 0) {
    for (let weekday = 1; weekday <= 7; weekday++) {
      await db.scheduleRule.create({
        data: { clinicId, branchId, dentistUserId: dentistId, roomId: rooms[0]!, weekday, startMinute: 8 * 60, endMinute: 18 * 60, validFrom: new Date(`${today}T00:00:00.000Z`), createdById: adminUserId },
      });
    }
  }

  const patientOf = async (dni: string) => (await db.patientIdentifier.findFirst({ where: { clinicId, type: 'DNI', number: dni, status: 'ACTIVE' }, select: { patientId: true } }))?.patientId ?? null;
  const [camila, lucia, mateo, jorge] = await Promise.all(['90000006', '90000001', '90000002', '90000004'].map(patientOf));
  if (!camila || !lucia || !mateo || !jorge) return { rooms: rooms.length, services: Object.keys(services).length, appointments: 0 };

  const startOfToday = limaToUtc(today, 0);
  if ((await db.appointment.count({ where: { clinicId, notes: { startsWith: DEMO_APPT_NOTE }, startsAt: { gte: startOfToday } } })) > 0) {
    return { rooms: rooms.length, services: Object.keys(services).length, appointments: 0 };
  }

  const nowMinute = Math.ceil((Date.now() + 5 * 60_000) / 300_000) * 300_000;
  const specs: { patientId: string; service: string; start: Date; status?: 'CONFIRMED' | 'CANCELLED' | 'NO_SHOW'; note: string; reason?: string }[] = [
    { patientId: camila, service: 'Consulta (demo)', start: new Date(nowMinute), note: `${DEMO_APPT_NOTE} primera consulta, lista para iniciar la atención` },
    { patientId: lucia, service: 'Control (demo)', start: new Date(nowMinute + 60 * 60_000), status: 'CONFIRMED', note: `${DEMO_APPT_NOTE} control con confirmación` },
    { patientId: mateo, service: 'Limpieza dental (demo)', start: limaToUtc(addDays(today, 1), 10 * 60), note: `${DEMO_APPT_NOTE} paciente menor, viene con su representante` },
    { patientId: jorge, service: 'Restauración (demo)', start: limaToUtc(addDays(today, 2), 11 * 60), note: `${DEMO_APPT_NOTE} cita de ejemplo` },
    { patientId: lucia, service: 'Consulta (demo)', start: limaToUtc(addDays(today, 1), 15 * 60), status: 'CANCELLED', reason: 'Cancelada por el paciente (demostración)', note: `${DEMO_APPT_NOTE} cancelada` },
    { patientId: jorge, service: 'Control (demo)', start: limaToUtc(addDays(today, -1), 9 * 60), status: 'NO_SHOW', reason: 'No asistió (demostración)', note: `${DEMO_APPT_NOTE} ausencia` },
  ];
  let created = 0;
  for (const s of specs) {
    const svc = services[s.service]!;
    const end = addMinutes(s.start, svc.minutes);
    await db.$transaction(async (tx) => {
      const appt = await tx.appointment.create({
        data: {
          clinicId, branchId, patientId: s.patientId, dentistUserId: dentistId, roomId: rooms[0]!, serviceId: svc.id, startsAt: s.start, endsAt: end,
          status: s.status ?? 'RESERVED', notes: s.note, createdById: receptionId,
          ...(s.status === 'CONFIRMED' ? { confirmedById: receptionId, confirmedAt: new Date() } : {}),
          ...(s.status === 'CANCELLED' ? { cancelReason: s.reason } : {}),
          ...(s.status === 'NO_SHOW' ? { noShowReason: s.reason } : {}),
        },
      });
      if (s.status === 'CANCELLED' || s.status === 'NO_SHOW') return;
      const starts = slotStarts(s.start, end);
      await tx.appointmentSlot.createMany({
        data: [
          ...starts.map((slotStart) => ({ resourceKind: 'DENTIST' as const, resourceId: dentistId, slotStart, ownerKind: 'APPOINTMENT' as const, ownerId: appt.id, clinicId })),
          ...starts.map((slotStart) => ({ resourceKind: 'ROOM' as const, resourceId: rooms[0]!, slotStart, ownerKind: 'APPOINTMENT' as const, ownerId: appt.id, clinicId })),
        ],
      });
    });
    created++;
  }
  return { rooms: rooms.length, services: Object.keys(services).length, appointments: created };
}
