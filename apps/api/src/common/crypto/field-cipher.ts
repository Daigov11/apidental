import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Abstracción de cifrado de datos sensibles A NIVEL DE CAMPO, preparada para uso futuro.
 *
 * ESTADO EN 3.2: **NO está activa en ninguna columna**. Los textos clínicos se guardan en claro dentro de MySQL;
 * el requisito efectivo antes de datos reales es el cifrado del VOLUMEN y de los RESPALDOS EXTERNOS, más una gestión
 * segura de los secretos (ver docs). Esta capa existe para activar el cifrado por campo sin reescribir los
 * servicios si una decisión legal o contractual lo exige.
 *
 * Diseño:
 *  - Un `context` (tabla|columna|clínica|fila) viaja como dato autenticado adicional (AAD) de AES-256-GCM: un valor
 *    cifrado copiado a otra fila, columna o clínica NO descifra.
 *  - Formato autodescriptivo `enc:v1:<keyId>:<iv>:<tag>:<texto>` (base64url): permite rotar claves (se cifra con la
 *    vigente y se descifra con cualquiera del llavero).
 *  - Cifrar impide buscar por contenido: los campos candidatos no deben usarse en filtros.
 */
export interface FieldCipher {
  readonly enabled: boolean;
  encrypt(plaintext: string, context: string): string;
  decrypt(stored: string, context: string): string;
}

/** Contexto canónico del AAD: evita construirlo a mano de forma distinta en cada servicio. */
export const cipherContext = (
  table: string,
  column: string,
  clinicId: string,
  rowId: string,
): string => [table, column, clinicId, rowId].join('|');

/** Modo apagado (por defecto): no transforma nada. */
export class PassthroughFieldCipher implements FieldCipher {
  readonly enabled = false;
  encrypt(plaintext: string, _context: string): string {
    return plaintext;
  }
  decrypt(stored: string, _context: string): string {
    return stored;
  }
}

const PREFIX = 'enc:v1:';

export class AesGcmFieldCipher implements FieldCipher {
  readonly enabled = true;
  private readonly keys: Map<string, Buffer>;

  /** `activeKeyId` cifra; `keys` (incluida la activa y las anteriores) descifran. Cada clave: 32 bytes. */
  constructor(
    private readonly activeKeyId: string,
    keys: Record<string, Buffer>,
  ) {
    this.keys = new Map(Object.entries(keys));
    for (const [id, key] of this.keys) {
      if (key.length !== 32)
        throw new Error(
          `La clave de cifrado "${id}" debe tener 32 bytes (AES-256)`,
        );
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id))
        throw new Error(
          'El identificador de clave solo admite letras, números, "_" y "-"',
        );
    }
    if (!this.keys.has(activeKeyId))
      throw new Error('La clave de cifrado activa no está en el llavero');
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.keys.get(this.activeKeyId)!,
      iv,
    );
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const b = (x: Buffer) => x.toString('base64url');
    return `${PREFIX}${this.activeKeyId}:${b(iv)}:${b(cipher.getAuthTag())}:${b(body)}`;
  }

  decrypt(stored: string, context: string): string {
    if (!stored.startsWith(PREFIX))
      throw new Error('Valor no cifrado o con formato desconocido');
    const [keyId, iv, tag, body] = stored.slice(PREFIX.length).split(':');
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (!key || !iv || !tag || body === undefined)
      throw new Error('Valor cifrado con una clave desconocida o dañado');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Mensaje fijo: nunca se filtra el contenido ni el motivo exacto.
      throw new Error(
        'No se pudo descifrar el valor (clave, contexto o contenido no coinciden)',
      );
    }
  }
}

/** Interpreta "id:base64,id2:base64" (claves anteriores para poder descifrar tras una rotación). */
export function parseKeyring(spec: string | undefined): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const part of (spec ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [id, b64] = part.split(':');
    if (!id || !b64)
      throw new Error(
        'Formato de claves anteriores inválido (use id:base64,id:base64)',
      );
    out[id] = Buffer.from(b64, 'base64');
  }
  return out;
}
