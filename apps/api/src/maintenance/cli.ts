import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnvFile } from '../config/load-env-file.js';

/**
 * Mantenimiento de seguridad desde la línea de comandos (para cron o un temporizador de systemd):
 *   node dist/maintenance/cli.js            # vence y depura
 *   node dist/maintenance/cli.js --dry-run  # solo cuenta lo que haría, sin modificar nada
 * Imprime un resumen JSON con contadores (nunca ids, correos ni tokens). Código de salida != 0 si falla.
 */
loadEnvFile();

const { AppModule } = await import('../app.module.js');
const { MaintenanceService } = await import('./maintenance.service.js');

const dryRun = process.argv.includes('--dry-run');
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const report = await app.get(MaintenanceService).run({ dryRun });
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({ error: 'maintenance_failed', type: error instanceof Error ? error.name : 'desconocido' }));
  process.exitCode = 1;
} finally {
  await app.close();
}
