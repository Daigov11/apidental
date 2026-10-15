import type { ContactTypeCode } from './normalize.js';

/** Enmascara un identificador/teléfono conservando los últimos 3 caracteres. */
export function maskTail(value: string): string {
  const keep = value.slice(-3);
  return `${'*'.repeat(Math.max(value.length - 3, 0))}${keep}`;
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${local.slice(0, 1)}***@***${tld}`;
}

/**
 * La auditoría es inmutable: por eso solo guarda valores ENMASCARADOS de datos personales.
 * El historial completo vive en las tablas de dominio (identificadores y contactos).
 */
export function maskContact(type: ContactTypeCode, value: string): string {
  if (type === 'EMAIL') return maskEmail(value);
  if (type === 'ADDRESS') return '[dirección omitida]';
  return maskTail(value);
}
