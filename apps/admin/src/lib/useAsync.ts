import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> { data: T | null; error: unknown; loading: boolean; reload: () => void }

/** Carga de datos con estados explícitos (cargando / error / datos) y recarga manual. */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fnRef.current(ctrl.signal).then(
      (d) => { if (!ctrl.signal.aborted) { setData(d); setLoading(false); } },
      (e: unknown) => { if (!ctrl.signal.aborted) { setError(e); setLoading(false); } },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}
