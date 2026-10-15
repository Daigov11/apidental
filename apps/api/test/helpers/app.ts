import type { INestApplication, LoggerService } from '@nestjs/common';
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
import { PasswordRecoveryService } from '../../src/auth/password-recovery.service.js';
import { DevDelivery, INVITATION_DELIVERY } from '../../src/invitations/delivery/invitation-delivery.js';

export interface TestContext {
  app: INestApplication;
  db: PrismaDb;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestContext(opts: { logger?: LoggerService } = {}): Promise<TestContext> {
  const db = createPrismaClient(process.env['DATABASE_URL']!, 3);
  await syncCatalog(db);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: opts.logger ?? false });
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
  password = PASSWORD,
): Promise<string> {
  const token = await login(ctx, email, password);
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

// ---------------------------------------------------------------------------
// Helpers de sesiones (refresh token en cookie HttpOnly)
// ---------------------------------------------------------------------------

export const ORIGIN = 'http://localhost:5173';
export const COOKIE_NAME = 'apidental_rt'; // en pruebas la cookie no es Secure, así que sin prefijo __Host-

/** Cabeceras que el panel envía en refresh/logout (barreras CSRF). */
export const csrfHeaders = { Origin: ORIGIN, 'X-Requested-With': 'ApiDental', 'Content-Type': 'application/json' } as const;

export function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** Valor del refresh token entregado en la cookie (null si no se envió o se está borrando). */
export function refreshTokenFrom(res: request.Response): string | null {
  const line = setCookies(res).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  const value = line?.split(';')[0]?.slice(COOKIE_NAME.length + 1) ?? '';
  return value ? decodeURIComponent(value) : null;
}

export const cookieHeader = (token: string) => `${COOKIE_NAME}=${encodeURIComponent(token)}`;

/** Inicia sesión y devuelve access token, refresh token (de la cookie) y la respuesta completa. */
export async function loginFull(ctx: TestContext, email: string, password = PASSWORD) {
  const res = await ctx.http().post('/v1/auth/login').send({ email, password }).expect(200);
  const refreshToken = refreshTokenFrom(res);
  if (!refreshToken) throw new Error('El login no entregó la cookie del refresh token');
  return { accessToken: res.body.accessToken as string, refreshToken, res };
}

export const refreshWith = (ctx: TestContext, refreshToken: string | null, headers: Record<string, string> = csrfHeaders) => {
  let req = ctx.http().post('/v1/auth/refresh').set(headers);
  if (refreshToken !== null) req = req.set('Cookie', cookieHeader(refreshToken));
  // Cadena y no objeto: así el cuerpo se envía tal cual aunque el Content-Type de la prueba no sea JSON.
  return req.send('{}');
};

export const sessionIdOf = (accessToken: string): string =>
  JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()).sid as string;

// ---------------------------------------------------------------------------
// Helpers de invitaciones (el canal "dev" devuelve el enlace SOLO en desarrollo/pruebas)
// ---------------------------------------------------------------------------

export const NEW_PASSWORD = 'Mi-Clave-Propia-2026';

export const tokenFromUrl = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '');

export const inviteReq = (ctx: TestContext, accessToken: string, body: Record<string, unknown>) =>
  ctx.http().post('/v1/invitations').set(bearer(accessToken)).send(body);

export const acceptReq = (ctx: TestContext, token: string, body: Record<string, unknown> = {}) =>
  ctx
    .http()
    .post('/v1/invitations/accept')
    .send({ token, password: NEW_PASSWORD, firstName: 'Nueva', lastName: 'Persona', ...body });

/** Crea una invitación (debe responder 201) y devuelve su id y el token del enlace de desarrollo. */
export async function inviteOk(ctx: TestContext, accessToken: string, body: Record<string, unknown>) {
  const res = await inviteReq(ctx, accessToken, body).expect(201);
  return { id: res.body.id as string, token: tokenFromUrl(res.body.devAcceptUrl as string), res };
}

/** Invita y acepta en un paso: devuelve las credenciales de la cuenta creada por la propia persona. */
export async function inviteAndAccept(
  ctx: TestContext,
  inviterAccessToken: string,
  body: { roleCode: string; clinicId?: string; branchId?: string; email?: string },
  password = NEW_PASSWORD,
) {
  const email = body.email ?? `${uniq('inv')}@test.pe`;
  const { id, token } = await inviteOk(ctx, inviterAccessToken, { ...body, email });
  await acceptReq(ctx, token, { password }).expect(200);
  return { email, password, invitationId: id };
}

/** Reautentica (contraseña correcta) y devuelve la prueba de un solo uso para ese propósito/objeto. */
export async function reauthProofFor(
  ctx: TestContext,
  accessToken: string,
  purpose: string,
  targetId?: string,
  password = PASSWORD,
): Promise<string> {
  const res = await ctx
    .http()
    .post('/v1/auth/reauthenticate')
    .set(bearer(accessToken))
    .send({ password, purpose, ...(targetId ? { targetId } : {}) })
    .expect(200);
  return res.body.reauthToken as string;
}


// ---------------------------------------------------------------------------
// Helpers de recuperación de contraseña
// ---------------------------------------------------------------------------

/** Buzón EN MEMORIA del canal de desarrollo (la respuesta de la recuperación es neutral y no lleva el enlace). */
export const devOutbox = (ctx: TestContext): DevDelivery => ctx.app.get<DevDelivery>(INVITATION_DELIVERY);

/** La solicitud responde de inmediato y trabaja después: esto espera a que termine. */
export const settleRecoveries = (ctx: TestContext): Promise<void> => ctx.app.get(PasswordRecoveryService).idle();

export const recoveryReq = (ctx: TestContext, email: string) => ctx.http().post('/v1/auth/password-recovery').send({ email });

/** Solicita la recuperación, espera el trabajo en segundo plano y devuelve el token entregado al correo. */
export async function requestRecovery(ctx: TestContext, email: string): Promise<string> {
  await recoveryReq(ctx, email).expect(202);
  await settleRecoveries(ctx);
  const message = devOutbox(ctx).last('password_recovery', email.toLowerCase());
  if (!message) throw new Error('No se entregó ninguna recuperación a ese correo');
  return tokenFromUrl(message.url);
}

export const confirmRecovery = (ctx: TestContext, token: string, newPassword: string) =>
  ctx.http().post('/v1/auth/password-recovery/confirm').send({ token, newPassword });

export const validateRecovery = (ctx: TestContext, token: string) =>
  ctx.http().post('/v1/auth/password-recovery/validate').send({ token });
