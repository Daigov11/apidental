import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { get } from '../api/client';
import type { Branch } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useAsync } from './useAsync';

interface BranchValue { branches: Branch[]; branchId: string | null; setBranchId: (id: string) => void; loading: boolean }
const Ctx = createContext<BranchValue | null>(null);
export const useBranch = (): BranchValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBranch fuera de BranchProvider');
  return v;
};

/** Sedes visibles en el contexto. Si el contexto ya está limitado a una sede, esa es la única. */
export function BranchProvider({ children }: { children: ReactNode }) {
  const { me, can } = useAuth();
  const list = useAsync(() => (can('branch:read') && me?.context?.clinic ? get<Branch[]>('/branches') : Promise.resolve([] as Branch[])), [me?.context?.clinic?.id, me?.context?.branch?.id]);
  const [picked, setPicked] = useState<string | null>(null);
  const branches = list.data ?? [];
  const branchId = me?.context?.branch?.id ?? (picked && branches.some((b) => b.id === picked) ? picked : (branches[0]?.id ?? null));
  const value = useMemo(() => ({ branches, branchId, setBranchId: setPicked, loading: list.loading }), [branches, branchId, list.loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
