import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AppConfig } from '../../src/config/app-config.js';
import { createPrismaClient, type PrismaDb } from '../../src/prisma/client.js';
import { syncCatalog } from '../../prisma/catalog.js';
import { hashPassword } from '../../src/common/utils/password.js';
import { assignmentKey } from '../../src/users/assignment-key.js';
import { limaToday } from '../../src/patients/util/lima-date.js';

export interface TestContext {
  app: INestApplication;
  db: PrismaDb;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const db = createPrismaClient(process.env['DATABASE_URL']!, 3);
  await syncCatalog(db);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, new AppConfig());
  await app.init();
  // supertest abre un listener por solicitud sobre el mismo servidor: evita la advertencia de fugas.
  app.getHttpServer().setMaxListeners(0);
  return {
    app,
    db,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await db.$disconnect();
    },
  };
}

let counter = 0;
export const uniq = (prefix = 'x'): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const PASSWORD = 'Clave-De-Prueba-123';

/** Crea datos de prueba directamente en la base (sin pasar por la API). */
export class Fixtures {
  private hashPromise = hashPassword(PASSWORD);
  constructor(private readonly db: PrismaDb) {}

  clinic(name = uniq('Clinica ')) {
    return this.db.clinic.create({ data: { name } });
  }

  branch(clinicId: string, name = uniq('Sede ')) {
    return this.db.branch.create({ data: { clinicId, name } });
  }

  async user(opts: { email?: string; status?: 'ACTIVE' | 'DISABLED' } = {}) {
    return this.db.user.create({
      data: {
        email: opts.email ?? `${uniq('u')}@test.pe`,
        passwordHash: await this.hashPromise,
        firstName: 'Nombre',
        lastName: 'Apellido',
        status: opts.status ?? 'ACTIVE',
      },
    });
  }

  async assign(userId: string, roleCode: string, scope: { clinicId?: string; branchId?: string } = {}) {
    const role = await this.db.role.findUniqueOrThrow({ where: { code: roleCode } });
    const grant = { roleId: role.id, clinicId: scope.clinicId ?? null, branchId: scope.branchId ?? null };
    return this.db.userAssignment.create({
      data: { userId, ...grant, assignmentKey: assignmentKey(userId, grant) },
    });
  }

  /** Usuario con un rol ya asignado. */
  async userWithRole(roleCode: string, scope: { clinicId?: string; branchId?: string } = {}) {
    const user = await this.user();
    const assignment = await this.assign(user.id, roleCode, scope);
    return { user, assignment };
  }
}

export async function login(ctx: TestContext, email: string, password = PASSWORD): Promise<string> {
  const res = await ctx.http().post('/v1/auth/login').send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Login + selección de contexto: devuelve un token con contexto activo. */
export async function loginInContext(
  ctx: TestContext,
  email: string,
  context: { clinicId?: string | null; branchId?: string | null } = {},
): Promise<string> {
  const token = await login(ctx, email);
  const res = await ctx
    .http()
    .post('/v1/auth/select-context')
    .set('Authorization', `Bearer ${token}`)
    .send(context)
    .expect(200);
  return res.body.accessToken as string;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Helpers del módulo de pacientes
// ---------------------------------------------------------------------------

export interface Actor {
  user: { id: string; email: string };
  token: string;
}

/** Usuario con un rol en la clínica/sede indicada, ya autenticado en ese contexto. */
export async function actorIn(
  ctx: TestContext,
  fx: Fixtures,
  roleCode: string,
  scope: { clinicId: string; branchId?: string },
): Promise<Actor> {
  const { user } = await fx.userWithRole(roleCode, scope);
  const token = await loginInContext(ctx, user.email, { clinicId: scope.clinicId, branchId: scope.branchId ?? null });
  return { user, token };
}

/** DNI de 8 dígitos único dentro de la ejecución de pruebas. */
const usedDni = new Set<string>();
export function dni(): string {
  for (;;) {
    const value = String(Math.floor(1e7 + Math.random() * 9e7));
    if (!usedDni.has(value)) {
      usedDni.add(value);
      return value;
    }
  }
}

/** Celular peruano de 9 dígitos único dentro de la ejecución. */
const usedMobile = new Set<string>();
export function mobile(): string {
  for (;;) {
    const value = `9${String(Math.floor(1e7 + Math.random() * 9e7))}`;
    if (!usedMobile.has(value)) {
      usedMobile.add(value);
      return value;
    }
  }
}

/** Fecha YYYY-MM-DD de hace `years` años (y `days` días) respecto de hoy en Lima. */
export function yearsAgo(years: number, days = 0): string {
  const [y, m, d] = limaToday();
  const date = new Date(Date.UTC(y - years, m - 1, d - days));
  return date.toISOString().slice(0, 10);
}

/** Cuerpos de archivo reales (firmas válidas) con contenido único para evitar el control de duplicados. */
export const makePdf = (tag = uniq('pdf')): Buffer =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${tag}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');
export const makePng = (tag = uniq('png')): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR-${tag}`)]);
export const makeJpeg = (tag = uniq('jpg')): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-${tag}`)]);

export const PATIENT_BASE = { firstName: 'José', birthDate: '1990-05-17' } as const;

/** Crea un paciente por la API y devuelve su id (falla la prueba si no responde 201). */
export async function createPatient(
  ctx: TestContext,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; res: request.Response }> {
  const res = await ctx
    .http()
    .post('/v1/patients')
    .set(bearer(token))
    .send({ firstName: 'Ana', lastName: uniq('Lopez'), ...body })
    .expect(201);
  return { id: res.body.patient.id as string, res };
}
