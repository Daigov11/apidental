import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { CookieCsrfGuard } from './csrf.guard.js';

const config = new AppConfig({
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
  JWT_ACCESS_SECRET: 's'.repeat(48),
  CORS_ORIGINS: 'https://dental.apiworking.com.pe, http://localhost:5173',
});
const guard = new CookieCsrfGuard(config);

const run = (headers: Record<string, string>) =>
  guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as ExecutionContext);

const good = { origin: 'https://dental.apiworking.com.pe', 'x-requested-with': 'ApiDental', 'content-type': 'application/json' };

describe('CookieCsrfGuard', () => {
  it('acepta una solicitud legítima del panel (cada origen configurado)', () => {
    expect(run(good)).toBe(true);
    expect(run({ ...good, origin: 'http://localhost:5173' })).toBe(true);
    expect(run({ ...good, 'content-type': 'application/json; charset=utf-8' })).toBe(true);
  });

  it.each([
    ['sin Origin', { ...good, origin: undefined as unknown as string }],
    ['Origin ajeno', { ...good, origin: 'https://evil.example' }],
    ['Origin "null" (iframe sandbox, documentos locales)', { ...good, origin: 'null' }],
    ['Origin con el mismo dominio en otro esquema', { ...good, origin: 'http://dental.apiworking.com.pe' }],
    ['Origin con subdominio extra', { ...good, origin: 'https://api.dental.apiworking.com.pe' }],
    ['Origin con sufijo malicioso', { ...good, origin: 'https://dental.apiworking.com.pe.evil.example' }],
    ['sin X-Requested-With', { ...good, 'x-requested-with': undefined as unknown as string }],
    ['X-Requested-With distinto', { ...good, 'x-requested-with': 'fetch' }],
    ['Content-Type de formulario', { ...good, 'content-type': 'application/x-www-form-urlencoded' }],
    ['Content-Type text/plain', { ...good, 'content-type': 'text/plain' }],
    ['sin Content-Type', { ...good, 'content-type': undefined as unknown as string }],
    ['Sec-Fetch-Site: cross-site', { ...good, 'sec-fetch-site': 'cross-site' }],
  ])('rechaza %s', (_label, headers) => {
    expect(() => run(headers)).toThrow(ForbiddenException);
  });
});
