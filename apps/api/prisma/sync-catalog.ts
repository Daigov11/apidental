import { loadEnvFile } from '../src/config/load-env-file.js';
import { syncCatalog } from './catalog.js';
import { createPrismaClient } from '../src/prisma/client.js';

loadEnvFile();
const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL no está definida');
const db = createPrismaClient(url, 2);
try {
  const r = await syncCatalog(db);
  console.log(`Catálogo sincronizado: ${r.permissions} permisos, ${r.roles} roles.`);
} finally {
  await db.$disconnect();
}
