import { randomBytes } from 'node:crypto';
import {
  AesGcmFieldCipher,
  cipherContext,
  parseKeyring,
  PassthroughFieldCipher,
} from './field-cipher.js';

const key = () => randomBytes(32);
const ctx = cipherContext(
  'clinical_history_entries',
  'observations',
  'clinica-1',
  'fila-1',
);

describe('FieldCipher (preparado, sin activar en columnas)', () => {
  it('el modo apagado no transforma nada', () => {
    const c = new PassthroughFieldCipher();
    expect(c.enabled).toBe(false);
    expect(c.decrypt(c.encrypt('texto', ctx), ctx)).toBe('texto');
  });

  it('AES-256-GCM: cifra y descifra, el texto cifrado no contiene el original y cada cifrado es distinto', () => {
    const c = new AesGcmFieldCipher('k1', { k1: key() });
    const a = c.encrypt('Alergia a la penicilina', ctx);
    const b = c.encrypt('Alergia a la penicilina', ctx);
    expect(a).toMatch(/^enc:v1:k1:/);
    expect(a).not.toContain('penicilina');
    expect(a).not.toBe(b);
    expect(c.decrypt(a, ctx)).toBe('Alergia a la penicilina');
    expect(c.decrypt(c.encrypt('', ctx), ctx)).toBe('');
    expect(c.decrypt(c.encrypt('ñandú — áéíóú 🦷', ctx), ctx)).toBe(
      'ñandú — áéíóú 🦷',
    );
  });

  it('el contexto autentica: copiar el valor a otra fila, columna o clínica no descifra', () => {
    const c = new AesGcmFieldCipher('k1', { k1: key() });
    const stored = c.encrypt('dato', ctx);
    for (const other of [
      cipherContext(
        'clinical_history_entries',
        'observations',
        'clinica-1',
        'fila-2',
      ),
      cipherContext('clinical_history_entries', 'label', 'clinica-1', 'fila-1'),
      cipherContext(
        'clinical_history_entries',
        'observations',
        'clinica-2',
        'fila-1',
      ),
    ]) {
      expect(() => c.decrypt(stored, other)).toThrow(/No se pudo descifrar/);
    }
  });

  it('detecta manipulación y no filtra contenido en los errores', () => {
    const c = new AesGcmFieldCipher('k1', { k1: key() });
    const parts = c.encrypt('secreto clínico', ctx).split(':');
    parts[parts.length - 1] =
      Buffer.from('otro contenido').toString('base64url');
    expect(() => c.decrypt(parts.join(':'), ctx)).toThrow(
      /No se pudo descifrar/,
    );
    expect(() => c.decrypt('texto en claro', ctx)).toThrow(/no cifrado/);
    try {
      c.decrypt(parts.join(':'), ctx);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secreto');
    }
  });

  it('rotación: se cifra con la clave activa y se sigue descifrando con las anteriores', () => {
    const old = key();
    const oldCipher = new AesGcmFieldCipher('k1', { k1: old });
    const stored = oldCipher.encrypt('historial', ctx);
    const rotated = new AesGcmFieldCipher('k2', { k2: key(), k1: old });
    expect(rotated.decrypt(stored, ctx)).toBe('historial');
    expect(rotated.encrypt('nuevo', ctx)).toMatch(/^enc:v1:k2:/);
    expect(() =>
      new AesGcmFieldCipher('k2', { k2: key() }).decrypt(stored, ctx),
    ).toThrow(/clave desconocida/);
  });

  it('rechaza claves que no son de 32 bytes, ids inválidos y llavero sin clave activa', () => {
    expect(() => new AesGcmFieldCipher('k1', { k1: randomBytes(16) })).toThrow(
      /32 bytes/,
    );
    expect(() => new AesGcmFieldCipher('k 1', { 'k 1': key() })).toThrow(
      /identificador/,
    );
    expect(() => new AesGcmFieldCipher('k9', { k1: key() })).toThrow(/activa/);
  });

  it('parseKeyring lee id:base64 y rechaza formatos rotos', () => {
    const k = key();
    expect(
      parseKeyring(`a:${k.toString('base64')}, b:${k.toString('base64')}`),
    ).toEqual({ a: k, b: k });
    expect(parseKeyring(undefined)).toEqual({});
    expect(() => parseKeyring('sinformato')).toThrow(/inválido/);
  });
});
