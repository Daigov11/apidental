const SENSITIVE_KEY = /pass(word)?|token|secret|hash|authorization|cookie/i;

/** Copia un objeto eliminando recursivamente claves sensibles (para auditoría y logs). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncado]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[omitido]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}
