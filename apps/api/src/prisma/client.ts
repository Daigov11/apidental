import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';

/** Crea el cliente Prisma. passwordHash queda excluido de toda consulta salvo petición explícita. */
export function createPrismaClient(databaseUrl: string, connectionLimit = 10) {
  const url = new URL(databaseUrl);
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit,
  });
  return new PrismaClient({ adapter, omit: { user: { passwordHash: true } } });
}

export type PrismaDb = ReturnType<typeof createPrismaClient>;

/** Cliente transaccional (lo que recibe el callback de $transaction). */
export type DbTx = Omit<
  PrismaDb,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;
