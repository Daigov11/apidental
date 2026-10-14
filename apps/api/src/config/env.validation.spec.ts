import { validateEnv } from './env.validation.js';

const base = {
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
};

describe('validateEnv', () => {
  it('aplica valores por defecto seguros', () => {
    const env = validateEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.LOGIN_MAX_ATTEMPTS).toBe(5);
  });

  it('convierte números desde strings', () => {
    expect(validateEnv({ ...base, PORT: '4100', TRUST_PROXY: '1' })).toMatchObject({ PORT: 4100, TRUST_PROXY: 1 });
  });

  it('exige DATABASE_URL y un secreto JWT largo', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'corto' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rechaza valores fuera de rango', () => {
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('en producción rechaza el secreto de ejemplo y CORS comodín', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => validateEnv({ ...prod, JWT_ACCESS_SECRET: 'change_me_'.repeat(5) })).toThrow(/ejemplo/);
    expect(() => validateEnv({ ...prod, CORS_ORIGINS: '*' })).toThrow(/CORS/);
    expect(() => validateEnv({ ...prod, CORS_ORIGINS: 'https://dental.apiworking.com.pe' })).not.toThrow();
  });
});
