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
