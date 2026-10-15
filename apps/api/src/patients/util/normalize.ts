import { BadRequestException } from '@nestjs/common';
import { normalizeEmail } from '../../common/utils/email.js';

export type IdentifierTypeCode = 'DNI' | 'CE' | 'PASSPORT';
export type ContactTypeCode = 'MOBILE' | 'PHONE' | 'EMAIL' | 'ADDRESS';

/**
 * DNI peruano: 8 dígitos (dato confirmado). Formatos de CE y pasaporte: por validar;
 * por ahora se aceptan 6-20 caracteres alfanuméricos.
 */
export function normalizeIdentifier(type: IdentifierTypeCode, raw: string): string {
  const value = raw.replace(/[\s-]/g, '');
  if (type === 'DNI') {
    if (!/^\d{8}$/.test(value)) throw new BadRequestException('El DNI debe tener exactamente 8 dígitos');
    return value;
  }
  if (!/^[A-Za-z0-9]{6,20}$/.test(value)) {
    throw new BadRequestException(`El número de ${type === 'CE' ? 'carné de extranjería' : 'pasaporte'} debe tener entre 6 y 20 caracteres alfanuméricos`);
  }
  return value.toUpperCase();
}

/** Solo dígitos; quita el prefijo +51/51 de celulares peruanos. Acepta 7-15 dígitos. */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/[\s().-]/g, '');
  if (!/^\+?\d{7,15}$/.test(digits)) throw new BadRequestException('Teléfono inválido: use entre 7 y 15 dígitos');
  digits = digits.replace(/^\+/, '');
  if (/^519\d{8}$/.test(digits)) digits = digits.slice(2);
  return digits;
}

export interface NormalizedContact {
  value: string;
  /** Clave comparable (dígitos / correo en minúsculas); null para direcciones. */
  valueKey: string | null;
}

export function normalizeContact(type: ContactTypeCode, raw: string): NormalizedContact {
  const trimmed = raw.trim();
  if (!trimmed) throw new BadRequestException('El valor del contacto es obligatorio');
  switch (type) {
    case 'MOBILE': {
      const digits = normalizePhone(trimmed);
      return { value: digits, valueKey: digits };
    }
    case 'PHONE': {
      const digits = normalizePhone(trimmed);
      return { value: digits, valueKey: digits };
    }
    case 'EMAIL': {
      const email = normalizeEmail(trimmed);
      if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new BadRequestException('Correo inválido');
      }
      return { value: email, valueKey: email };
    }
    case 'ADDRESS':
      return { value: trimmed.slice(0, 300), valueKey: null };
  }
}
