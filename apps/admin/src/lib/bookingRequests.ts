import { useCallback, useEffect, useState } from 'react';
import { get } from '../api/client';

const CHANGED = 'booking-requests-changed';
/** Avisa al menú que las solicitudes cambiaron (se atendió o rechazó una): recarga la insignia. */
export const notifyRequestsChanged = (): void => { window.dispatchEvent(new Event(CHANGED)); };

/** Número de solicitudes pendientes. Si la consulta falla (sin permiso o sin la función), devuelve null y no se muestra insignia. */
export function usePendingRequests(enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  const load = useCallback(() => {
    get<{ pending: number }>('/booking-requests/count').then((r) => setCount(r.pending), () => setCount(null));
  }, []);
  useEffect(() => {
    if (!enabled) { setCount(null); return; }
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener(CHANGED, load);
    return () => { clearInterval(timer); window.removeEventListener(CHANGED, load); };
  }, [enabled, load]);
  return count;
}
