import { BadRequestException } from '@nestjs/common';
import { maskContact, maskEmail, maskTail } from './mask.js';
import { normalizeContact, normalizeIdentifier, normalizePhone } from './normalize.js';

describe('normalizeIdentifier', () => {
  it('DNI: exactamente 8 dígitos', () => {
    expect(normalizeIdentifier('DNI', '12 34 56-78')).toBe('12345678');
    for (const bad of ['1234567', '123456789', '1234567a', '']) {
      expect(() => normalizeIdentifier('DNI', bad)).toThrow(BadRequestException);
    }
  });

  it('CE y pasaporte: alfanumérico 6-20 en mayúsculas (formato por validar)', () => {
    expect(normalizeIdentifier('CE', 'ab123456')).toBe('AB123456');
    expect(normalizeIdentifier('PASSPORT', 'x1y2z3w')).toBe('X1Y2Z3W');
    expect(() => normalizeIdentifier('CE', '123')).toThrow(BadRequestException);
    expect(() => normalizeIdentifier('PASSPORT', 'AB 12$456')).toThrow(BadRequestException);
  });
});

describe('normalizePhone / normalizeContact', () => {
  it('quita separadores y el prefijo +51 de celulares peruanos', () => {
    expect(normalizePhone('+51 987 654 321')).toBe('987654321');
    expect(normalizePhone('987-654-321')).toBe('987654321');
    expect(normalizePhone('(01) 234 5678')).toBe('012345678');
  });

  it('conserva números internacionales y rechaza basura', () => {
    expect(normalizePhone('+1 415 555 0100')).toBe('14155550100');
    for (const bad of ['abc', '123', '1'.repeat(16), '98765432a']) {
      expect(() => normalizePhone(bad)).toThrow(BadRequestException);
    }
  });

  it('correos en minúsculas, direcciones sin clave de comparación', () => {
    expect(normalizeContact('EMAIL', '  Ana@Correo.PE ')).toEqual({ value: 'ana@correo.pe', valueKey: 'ana@correo.pe' });
    expect(normalizeContact('ADDRESS', ' Av. Lima 123 ')).toEqual({ value: 'Av. Lima 123', valueKey: null });
    expect(() => normalizeContact('EMAIL', 'no-es-correo')).toThrow(BadRequestException);
    expect(() => normalizeContact('ADDRESS', '   ')).toThrow(BadRequestException);
  });
});

describe('enmascarado para auditoría', () => {
  it('conserva solo los últimos 3 caracteres', () => {
    expect(maskTail('12345678')).toBe('*****678');
    expect(maskTail('12')).toBe('12');
  });

  it('enmascara correos y direcciones', () => {
    expect(maskEmail('ana.perez@clinica.com.pe')).toBe('a***@***.pe');
    expect(maskContact('EMAIL', 'ana@x.pe')).not.toContain('ana@x');
    expect(maskContact('ADDRESS', 'Av. Siempre Viva 742')).toBe('[dirección omitida]');
    expect(maskContact('MOBILE', '987654321')).toBe('******321');
  });
});
