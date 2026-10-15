import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'mariadb';
import { loadEnvFile } from '../src/config/load-env-file.js';

/** Aplica las migraciones a la base de pruebas y la deja vacía antes de cada ejecución. */
export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  const url = process.env['TEST_DATABASE_URL'];
  if (!url || !/_test(\?|$)/.test(url)) {
    throw new Error('TEST_DATABASE_URL debe estar definida y apuntar a una base *_test');
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url },
  });

  // Adjuntos de pruebas: carpeta temporal vacía (jamás el directorio de desarrollo).
  const dir = join(tmpdir(), 'apidental-e2e-attachments');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const tables = (await conn.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> '_prisma_migrations'",
    )) as { name: string }[];
    // TRUNCATE no dispara los triggers de inmutabilidad: es el único modo de limpiar audit_logs.
    for (const t of tables) await conn.query(`TRUNCATE TABLE \`${t.name}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await conn.end();
  }
}
