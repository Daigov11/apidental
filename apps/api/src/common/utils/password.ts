import * as argon2 from 'argon2';

/** Argon2id con parámetros mínimos recomendados por OWASP (19 MiB, 2 iteraciones). */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, OPTIONS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export const passwordNeedsRehash = (hash: string): boolean => argon2.needsRehash(hash, OPTIONS);

/** Hash de relleno para igualar tiempos cuando el usuario no existe (evita enumeración). */
let dummyHash: Promise<string> | undefined;
export const getDummyHash = (): Promise<string> =>
  (dummyHash ??= hashPassword('contraseña-de-relleno-no-valida'));
