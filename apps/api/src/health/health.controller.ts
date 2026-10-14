import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';

const DB_TIMEOUT_MS = 2_000;

@Controller('health')
export class HealthController {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb) {}

  /** Sin datos sensibles: solo estado de la API y de la conexión a la base de datos. */
  @Public()
  @Get()
  async check() {
    const timestamp = new Date().toISOString();
    try {
      await Promise.race([
        this.db.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS)),
      ]);
      return { status: 'ok', checks: { database: 'up' }, timestamp };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        checks: { database: 'down' },
        timestamp,
      });
    }
  }
}
