import { createContext, useContext, type ReactNode } from 'react';
import { get } from '../api/client';
import type { IntegrationStatus } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useAsync } from './useAsync';

const OFF: IntegrationStatus = { mode: 'off', simulation: null, scenarios: [] };
const Ctx = createContext<IntegrationStatus>(OFF);
export const useIntegrations = (): IntegrationStatus => useContext(Ctx);

/** Modo de las integraciones (apagado o simulado). El panel solo muestra cobros, comprobantes y fidelización en modo simulado. */
export function IntegrationsProvider({ children }: { children: ReactNode }) {
  const { me, can } = useAuth();
  const allowed = Boolean(me?.context?.clinic) && (can('appointment:read') || can('charge:read') || can('billing:read') || can('loyalty:read'));
  const s = useAsync(() => (allowed ? get<IntegrationStatus>('/integrations/status') : Promise.resolve(OFF)), [allowed, me?.context?.clinic?.id]);
  return <Ctx.Provider value={s.data ?? OFF}>{children}</Ctx.Provider>;
}
