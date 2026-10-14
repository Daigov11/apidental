import { defineConfig } from 'prisma/config';

// Prisma 7 no carga .env automáticamente. El .env vive en la raíz del monorepo.
for (const file of ['../../.env', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // el archivo no existe: se usan las variables ya presentes en el entorno
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'] || undefined,
  },
});
