export type AllowedMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export const ALLOWED_MIME: readonly AllowedMime[] = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/**
 * Detecta el tipo por los primeros bytes (firma del archivo). Nunca se confía en el
 * Content-Type ni en la extensión declarados por el cliente. Devuelve null si no es un
 * formato permitido (PDF, JPEG, PNG, WebP).
 */
export function sniffMime(buf: Buffer): AllowedMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Nombre solo para mostrar: sin rutas, sin caracteres de control, acotado. Nunca se usa como ruta en disco. */
export function sanitizeFileName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  const trimmed = cleaned.replace(/^\.+/, '').slice(-120);
  return trimmed || 'archivo';
}
