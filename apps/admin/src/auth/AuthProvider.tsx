import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, get, onSessionLost, post, refreshAccessToken, setAccessToken } from '../api/client';
import type { ContextSelected, LoginBody, LoginContext, Me } from '../api/types';

export type AuthStatus = 'loading' | 'anonymous' | 'choose-context' | 'ready';

interface AuthValue {
  status: AuthStatus;
  me: Me | null;
  contexts: LoginContext[];
  notice: string | null;
  login: (email: string, password: string) => Promise<void>;
  chooseContext: (c: LoginContext) => Promise<void>;
  switchContext: () => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

const Ctx = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fuera de AuthProvider');
  return v;
}

const LOST = 'Su sesión terminó. Ingrese de nuevo para continuar.';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [contexts, setContexts] = useState<LoginContext[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  const reset = useCallback((message: string | null) => {
    setAccessToken(null);
    setMe(null);
    setContexts([]);
    setNotice(message);
    setStatus('anonymous');
  }, []);

  const enter = useCallback(async () => {
    const info = await get<Me>('/auth/me');
    setMe(info);
    if (info.context) {
      setStatus('ready');
      return;
    }
    const list = await get<LoginContext[]>('/auth/context');
    setContexts(list);
    setStatus('choose-context');
  }, []);

  useEffect(() => {
    onSessionLost(() => reset(LOST));
    return () => onSessionLost(null);
  }, [reset]);

  // Al abrir el panel: si hay cookie de sesión válida se retoma sin pedir la contraseña.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      if (!(await refreshAccessToken())) return reset(null);
      try {
        await enter();
      } catch {
        reset(null);
      }
    })();
  }, [enter, reset]);

  const selectAndEnter = useCallback(
    async (c: LoginContext) => {
      const res = await post<ContextSelected>('/auth/select-context', { clinicId: c.clinic?.id ?? null, branchId: c.branch?.id ?? null });
      setAccessToken(res.accessToken);
      await enter();
    },
    [enter],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      setNotice(null);
      const res = await post<LoginBody>('/auth/login', { email, password }, { anonymous: true });
      setAccessToken(res.accessToken);
      if (res.contexts.length === 0) {
        setAccessToken(null);
        throw new ApiError(403, 'Su cuenta todavía no tiene accesos asignados. Consulte con el administrador de su clínica.');
      }
      setContexts(res.contexts);
      if (res.contexts.length === 1) await selectAndEnter(res.contexts[0]!);
      else {
        const info = await get<Me>('/auth/me');
        setMe(info);
        setStatus('choose-context');
      }
    },
    [selectAndEnter],
  );

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout', {}, { anonymous: true });
    } catch {
      // aunque falle la red, se cierra la sesión local
    }
    reset(null);
  }, [reset]);

  const switchContext = useCallback(async () => {
    setContexts(await get<LoginContext[]>('/auth/context'));
    setStatus('choose-context');
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status, me, contexts, notice, login, chooseContext: selectAndEnter, switchContext, logout,
      can: (p) => me?.permissions.includes(p) ?? false,
    }),
    [status, me, contexts, notice, login, selectAndEnter, switchContext, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
