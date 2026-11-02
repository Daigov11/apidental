import { validateEnv } from '../config/env.validation.js';
import { allowed, moneyToCents, parseJsonKeepingBigIds } from './apiworking.client.js';
import { parseLogin } from './apiworking-auth.service.js';
import { parseCustomer } from './apiworking-clients.service.js';
import { suggestDocument } from './apiworking-sales.service.js';

describe('lectura estricta de Apiworking', () => {
  it('convierte ids grandes en texto sin tocar cadenas ni decimales', () => {
    const v = parseJsonKeepingBigIds('{"id":201900000000123456,"nota":"ref 201900000000123456","precio":1234567890123456.5,"chico":202600000038,"neg":-123456789012345678}') as Record<string, unknown>;
    expect(v['id']).toBe('201900000000123456');
    expect(v['nota']).toBe('ref 201900000000123456');
    expect(v['precio']).toBe(1234567890123456.5);
    expect(v['chico']).toBe(202600000038); // 12 dígitos: es seguro como número (reqId lo vuelve texto)
    expect(v['neg']).toBe('-123456789012345678');
  });

  it('lee importes con formato variable sin coma flotante', () => {
    expect(moneyToCents('17,069.05')).toBe(1_706_905);
    expect(moneyToCents('17069.05')).toBe(1_706_905);
    expect(moneyToCents('0.5')).toBe(50);
    expect(moneyToCents('100')).toBe(10_000);
    expect(moneyToCents(12.34)).toBe(1234);
    expect(moneyToCents('abc')).toBeNull();
    expect(moneyToCents('1,2')).toBeNull();
    expect(moneyToCents(undefined)).toBeNull();
  });

  it('el login exige token, id_usuario y usuario; el tenant puede faltar (se rechaza después)', () => {
    const ok = parseLogin({ token: 'abcdefghijk', id_usuario: 7, usuario: 'gina', nombrecompleto: 'Gina P', id_sucursal: 1, empresa: { base_datos: 'prod_x' } });
    expect(ok).toMatchObject({ userId: '7', username: 'gina', tenant: 'prod_x', branchId: '1' });
    expect(parseLogin({ token: 'abcdefghijk', id_usuario: 7, usuario: 'g' }).tenant).toBe('');
    expect(() => parseLogin({ id_usuario: 7, usuario: 'g' })).toThrow(/token/);
    expect(() => parseLogin({ token: 'abcdefghijk', usuario: 'g' })).toThrow(/id_usuario/);
  });

  it('lee un cliente de la lista de Apiworking', () => {
    const c = parseCustomer({ total: 40, id_cliente: 202600000038, id_persona: 202600000049, nombrecompleto: 'ROBERTO CARLOS', email: '', tipoDoc: 'D.N.I.', numerodocumento: '74908568', telefono: '', tipo_persona: 'N', estado: 'A', whatsapp: '' });
    expect(c).toMatchObject({ id: '202600000038', docType: 'D.N.I.', docNumber: '74908568', active: true });
    expect(parseCustomer({ id_cliente: 1, estado: 'I' }).active).toBe(false);
    expect(() => parseCustomer({ nombrecompleto: 'sin id' })).toThrow(/id_cliente/);
  });

  it('sugiere el comprobante según el documento del cliente', () => {
    expect(suggestDocument('R.U.C.')).toBe('FACTURA');
    expect(suggestDocument('D.N.I.')).toBe('BOLETA');
    expect(suggestDocument('C.E.')).toBe('NOTA_DE_VENTA');
  });
});

describe('configuración de Apiworking', () => {
  const base = { DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db', JWT_ACCESS_SECRET: 'x'.repeat(40) };
  const aw = { APIWORKING_SYSTEM_ID: 'https://tiendaglowsmile.apiworking.co/', APIWORKING_AUTHZ_EXPECTED_DATABASE: 'prod_ti_tiendaglowsmile' };

  it('por defecto todo está apagado y no exige nada', () => {
    const env = validateEnv(base);
    expect(env).toMatchObject({ AUTH_MODE: 'local', APIWORKING_AUTHZ_READ: 'false', APIWORKING_AUTHZ_WRITE: 'false', APIWORKING_MAX_REAL_OPERATIONS: 0 });
  });

  it('exige sistema y tenant esperado para usar Apiworking', () => {
    expect(() => validateEnv({ ...base, AUTH_MODE: 'apiworking' })).toThrow(/APIWORKING_SYSTEM_ID/);
    expect(() => validateEnv({ ...base, AUTH_MODE: 'apiworking', APIWORKING_SYSTEM_ID: 'x' })).toThrow(/EXPECTED_DATABASE/);
    expect(() => validateEnv({ ...base, AUTH_MODE: 'apiworking', ...aw })).not.toThrow();
  });

  it('la URL base solo puede ser de apiworking.pe o apiworking.co y con https en producción', () => {
    const on = { ...base, AUTH_MODE: 'apiworking', ...aw };
    expect(() => validateEnv({ ...on, APIWORKING_BASE_URL: 'https://evil.example.com' })).toThrow(/apiworking/);
    expect(() => validateEnv({ ...on, APIWORKING_BASE_URL: 'https://apiworking.pe.evil.com' })).toThrow(/apiworking/);
    expect(() => validateEnv({ ...on, APIWORKING_BASE_URL: 'https://api-centralizador.apiworking.pe' })).not.toThrow();
    const prod = { ...on, NODE_ENV: 'production', ATTACHMENTS_DIR: '/var/lib/x' };
    expect(() => validateEnv({ ...prod, APIWORKING_BASE_URL: 'http://api-centralizador.apiworking.pe' })).toThrow(/https/);
    expect(() => validateEnv({ ...prod, APIWORKING_BASE_URL: 'http://127.0.0.1:9' })).toThrow(/https|local/);
  });

  it('escribir exige leer; las listas autorizadas y el almacén son opcionales (almacén y unidad solo se piden al vender)', () => {
    const on = { ...base, ...aw, APIWORKING_AUTHZ_WRITE: 'true' };
    expect(() => validateEnv(on)).toThrow(/AUTHZ_READ/);
    expect(() => validateEnv({ ...on, APIWORKING_AUTHZ_READ: 'true' })).not.toThrow();
  });

  it('una lista vacía deja pasar lo que Apiworking informa; una lista con ids restringe', () => {
    expect(allowed([], '5')).toBe(true);
    expect(allowed(['5'], '5')).toBe(true);
    expect(allowed(['5'], '6')).toBe(false);
  });
});
