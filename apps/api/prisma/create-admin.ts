import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { loadEnvFile } from '../src/config/load-env-file.js';
import { hashPassword } from '../src/common/utils/password.js';
import { normalizeEmail } from '../src/common/utils/email.js';
import { createPrismaClient } from '../src/prisma/client.js';
import { assignmentKey } from '../src/users/assignment-key.js';

/**
 * Crea (o reutiliza) un administrador de plataforma. Es el mecanismo de bootstrap seguro:
 *   - La contraseña se pide por terminal sin eco (nunca como argumento ni en el historial).
 *   - BOOTSTRAP_ADMIN_PASSWORD solo se acepta fuera de producción (automatización local/CI).
 *   - Requiere haber ejecutado el seed antes (crea los roles).
 */
loadEnvFile();

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    'first-name': { type: 'string', default: 'Administrador' },
    'last-name': { type: 'string', default: 'Plataforma' },
  },
});
const isProduction = process.env['NODE_ENV'] === 'production';

function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(question);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env['BOOTSTRAP_ADMIN_PASSWORD'];
  if (fromEnv) {
    if (isProduction) throw new Error('En producción la contraseña solo se acepta por terminal interactiva');
    return fromEnv;
  }
  if (!process.stdin.isTTY) throw new Error('Se requiere una terminal interactiva para ingresar la contraseña');
  const first = await promptHidden('Contraseña (mínimo 12 caracteres): ');
  const second = await promptHidden('Repita la contraseña: ');
  if (first !== second) throw new Error('Las contraseñas no coinciden');
  return first;
}

const email = values.email ? normalizeEmail(values.email) : undefined;
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  throw new Error('Uso: npm run db:create-admin -w apps/api -- --email correo@dominio.pe [--first-name X --last-name Y]');
}
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL no está definida');

const db = createPrismaClient(databaseUrl, 2);
try {
  const role = await db.role.findUnique({ where: { code: 'PLATFORM_ADMIN' } });
  if (!role) throw new Error('No existe el rol PLATFORM_ADMIN: ejecute primero el seed (npm run db:seed -w apps/api)');

  let user = await db.user.findUnique({ where: { email } });
  if (user) {
    console.log(`El usuario ${email} ya existe: se conserva su contraseña y se asegura el rol.`);
  } else {
    const password = await readPassword();
    if (password.length < 12 || password.length > 128) throw new Error('La contraseña debe tener entre 12 y 128 caracteres');
    user = await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        firstName: values['first-name']!,
        lastName: values['last-name']!,
      },
    });
  }
  const grant = { roleId: role.id, clinicId: null, branchId: null };
  const key = assignmentKey(user.id, grant);
  const assignment = await db.userAssignment.upsert({
    where: { assignmentKey: key },
    update: { status: 'ACTIVE' },
    create: { userId: user.id, ...grant, assignmentKey: key },
  });
  await db.auditLog.create({
    data: {
      action: 'ADMIN_BOOTSTRAPPED',
      entity: 'User',
      entityId: user.id,
      userId: user.id,
      summary: { email, assignmentId: assignment.id, via: 'create-admin' },
    },
  });
  console.log(`Administrador de plataforma listo: ${email}`);
} finally {
  await db.$disconnect();
}
