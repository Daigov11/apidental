import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../src/config/load-env-file.js';

// Las pruebas e2e SIEMPRE usan TEST_DATABASE_URL, nunca la base de desarrollo.
loadEnvFile();

const testDb = process.env['TEST_DATABASE_URL'];
if (!testDb) {
  throw new Error('Defina TEST_DATABASE_URL en .env (base apidental_test) para ejecutar las pruebas e2e');
}
if (!/_test(\?|$)/.test(testDb)) {
  throw new Error('TEST_DATABASE_URL debe apuntar a una base cuyo nombre termine en _test');
}

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = testDb;
process.env['JWT_ACCESS_SECRET'] = 'e2e-secret-'.padEnd(48, 'x');
process.env['JWT_ACCESS_TTL_SECONDS'] = '900';
process.env['CORS_ORIGINS'] = 'http://localhost:5173';
process.env['LOGIN_MAX_ATTEMPTS'] = '3';
process.env['LOGIN_LOCK_MINUTES'] = '5';
process.env['RATE_LIMIT_PER_MINUTE'] = '100000';
// Sin enfriamiento entre recuperaciones en las pruebas (se prueba aparte, con otro valor).
process.env['PASSWORD_RECOVERY_COOLDOWN_SECONDS'] = '0';
process.env['LOGIN_RATE_LIMIT_PER_MINUTE'] = '100000';

// Directorio privado de adjuntos SOLO para pruebas (global-setup lo recrea vacío en cada ejecución).
process.env['ATTACHMENTS_DIR'] = join(tmpdir(), 'apidental-e2e-attachments');
process.env['ATTACHMENT_MAX_BYTES'] = '1048576';
