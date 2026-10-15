import { ConflictException, NotFoundException } from '@nestjs/common';

/** Nombres de campos cuyo valor difiere entre dos versiones (nunca los valores: van a la auditoría). */
export function changedFieldNames<T extends Record<string, unknown>>(
  before: T,
  after: T,
  names: readonly (keyof T & string)[],
): string[] {
  const norm = (v: unknown) =>
    v instanceof Date ? v.toISOString() : (v ?? null);
  return names.filter((n) => norm(before[n]) !== norm(after[n]));
}

export function versionConflict(currentVersion: number): ConflictException {
  // Solo el número de versión: nada del contenido.
  return new ConflictException({
    message:
      'El registro cambió desde que lo consultó; vuelva a leerlo antes de modificarlo',
    code: 'VERSION_CONFLICT',
    currentVersion,
  });
}

export const recordNotFound = (): NotFoundException =>
  new NotFoundException('Registro clínico no encontrado');

export function stateConflict(message: string): ConflictException {
  return new ConflictException({ message, code: 'INVALID_STATE' });
}
