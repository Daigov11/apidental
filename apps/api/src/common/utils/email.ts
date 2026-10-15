export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Identidad canónica de un correo, para detectar que dos direcciones apuntan a la MISMA bandeja:
 * ignora mayúsculas, la etiqueta `+algo` del usuario y, en Gmail, los puntos. No es infalible (un alias
 * en un dominio propio no es detectable): es una barrera barata contra la autoinvitación por alias, que se
 * complementa con la separación de funciones al asignar pacientes.
 */
export function canonicalEmailIdentity(email: string): string {
  const [rawLocal = '', rawDomain = ''] = normalizeEmail(email).split('@');
  let domain = rawDomain;
  let local = rawLocal.split('+')[0] ?? '';
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replaceAll('.', '');
  }
  return `${local}@${domain}`;
}
