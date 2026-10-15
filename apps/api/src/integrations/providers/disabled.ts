import { IntegrationsDisabledError } from './billing-provider.js';

const METHODS = new Set(['emit', 'getStatus', 'accrue', 'redeem', 'summary', 'nfcSummary', 'requestReview']);

/** Proveedor de relleno cuando INTEGRATIONS_MODE=off: cualquier uso falla de forma explícita. */
export function disabledProvider<T extends object>(): T {
  return new Proxy({} as T, {
    get: (_t, prop) => {
      if (prop === 'name') return 'disabled';
      if (prop === 'simulated') return false;
      // Solo los métodos del puerto fallan; los ganchos del ciclo de vida de Nest y `then` no existen.
      if (typeof prop !== 'string' || !METHODS.has(prop)) return undefined;
      return () => Promise.reject(new IntegrationsDisabledError('Las integraciones no están activadas'));
    },
  });
}
