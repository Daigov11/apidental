import { limaToUtc, utcToLima } from '../src/agenda/agenda-time.js';
import { loadEnvFile } from '../src/config/load-env-file.js';
import { createPrismaClient } from '../src/prisma/client.js';

/**
 * Mueve a horario de trabajo (09:00–17:00 de Lima) las citas DEMO de hoy que quedaron fuera de él (p. ej. las sembradas a
 * las 04:40). Cambia la cita y sus huecos de agenda juntos y evita choques. Idempotente. Solo citas con nota «Demo» y estado Reservado o Confirmado: las atendidas, canceladas o ausentes no se modifican (lo impide la base).
 * Uso: npm run db:demo-hoy -w apps/api
 */
loadEnvFile();
const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL no está definida');
const db = createPrismaClient(url, 2);

const WORK_START = 8 * 60;
const WORK_END = 18 * 60;

try {
  const today = utcToLima(new Date()).date;
  const rows = await db.appointment.findMany({
    where: { notes: { startsWith: 'Demo' }, status: { in: ['RESERVED', 'CONFIRMED'] }, startsAt: { gte: limaToUtc(today, 0), lt: limaToUtc(today, 24 * 60) } },
    orderBy: { startsAt: 'asc' },
  });
  let moved = 0;
  let nextHour = 9 * 60;
  for (const a of rows) {
    const minute = utcToLima(a.startsAt).minute;
    if (minute >= WORK_START && minute < WORK_END) continue;
    const durationMin = Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000);
    const slots = await db.appointmentSlot.findMany({ where: { ownerKind: 'APPOINTMENT', ownerId: a.id } });
    let placed = false;
    for (let target = nextHour; target + durationMin <= 17 * 60 && !placed; target += 30) {
      const newStart = limaToUtc(today, target + (minute % 60 >= 30 ? 0 : 0));
      const delta = newStart.getTime() - a.startsAt.getTime();
      const clash = await db.appointmentSlot.count({
        where: {
          OR: slots.map((s) => ({ resourceKind: s.resourceKind, resourceId: s.resourceId, slotStart: new Date(s.slotStart.getTime() + delta) })),
          NOT: { ownerId: a.id },
        },
      });
      if (clash > 0) continue;
      await db.$transaction(async (tx) => {
        await tx.appointmentSlot.deleteMany({ where: { ownerKind: 'APPOINTMENT', ownerId: a.id } });
        await tx.appointmentSlot.createMany({ data: slots.map((s) => ({ ...s, slotStart: new Date(s.slotStart.getTime() + delta) })) });
        await tx.appointment.update({ where: { id: a.id }, data: { startsAt: newStart, endsAt: new Date(newStart.getTime() + durationMin * 60_000), version: { increment: 1 } } });
      });
      nextHour = target + durationMin + 30;
      moved++;
      placed = true;
    }
  }
  console.log(`Citas demo de hoy movidas a horario de trabajo: ${moved}`);
} finally {
  await db.$disconnect();
}
