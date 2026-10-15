/**
 * Deadlocks y conflictos de escritura entre transacciones concurrentes son transitorios: se reintentan.
 * Prisma los reporta como P2034, pero cuando ocurren dentro de una consulta cruda (`SELECT ... FOR UPDATE`)
 * llegan como P2010 con el código de MySQL 1213 (deadlock) o 1205 (espera de bloqueo agotada).
 */
export function isTransientTxError(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } } };
  if (e?.code === 'P2034') return true;
  if (e?.code !== 'P2010') return false;
  const cause = e.meta?.driverAdapterError?.cause;
  return cause?.originalCode === '1213' || cause?.originalCode === '1205' || cause?.kind === 'TransactionWriteConflict' || /Code: `(1213|1205)`/.test(e.message ?? '');
}

export async function withTxRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientTxError(error) || i >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 20 * i + Math.floor(Math.random() * 30)));
    }
  }
}
