import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { CalendarDays, FileText, Home, LogOut, Repeat, Users, Wallet } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { BranchProvider } from '../lib/branch';
import { IntegrationsProvider, useIntegrations } from '../lib/integrations';
import { SimulationBanner } from '../ui/SimulationBanner';
import { Button } from '../ui/Button';

interface Item { to: string; label: string; icon: ReactNode; show: boolean; end?: boolean }

export function AppShell() {
  return (
    <IntegrationsProvider>
      <Shell />
    </IntegrationsProvider>
  );
}

function Shell() {
  const { me, can, logout, switchContext } = useAuth();
  const { mode } = useIntegrations();
  const clinicName = me?.context?.clinic?.name ?? 'ApiDental';
  const branchName = me?.context?.branch?.name ?? 'Todas las sedes';
  const hasClinic = Boolean(me?.context?.clinic);
  // La ausencia de permiso oculta el módulo; nunca se muestra "deshabilitado".
  const items: Item[] = [
    { to: '/', label: 'Hoy', icon: <Home size={20} aria-hidden="true" />, show: true, end: true },
    { to: '/agenda', label: 'Agenda', icon: <CalendarDays size={20} aria-hidden="true" />, show: hasClinic && can('appointment:read') },
    { to: '/pacientes', label: 'Pacientes', icon: <Users size={20} aria-hidden="true" />, show: hasClinic && (can('patient:read_basic') || can('patient:read')) },
    { to: '/caja', label: 'Caja', icon: <Wallet size={20} aria-hidden="true" />, show: hasClinic && mode === 'mock' && can('charge:read') },
    { to: '/comprobantes', label: 'Comprobantes', icon: <FileText size={20} aria-hidden="true" />, show: hasClinic && mode === 'mock' && can('billing:read') },
  ];
  return (
    <BranchProvider>
      <a className="skip-link" href="#main">Saltar al contenido</a>
      <div className="shell">
        <aside className="sidebar">
          <p className="brand"><span aria-hidden="true">◆</span><span>ApiDental<small>by Apiworking</small></span></p>
          <nav aria-label="Principal" className="nav">
            {items.filter((i) => i.show).map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} title={i.label}>
                {i.icon}
                <span className="nav-label">{i.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span className="label">{me?.user.firstName} {me?.user.lastName}</span>
            <Button variant="tertiary" size="sm" onClick={() => void switchContext()} icon={<Repeat size={18} aria-hidden="true" />}><span className="label">Cambiar sede</span></Button>
            <Button variant="tertiary" size="sm" onClick={() => void logout()} icon={<LogOut size={18} aria-hidden="true" />}><span className="label">Cerrar sesión</span></Button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <strong>{clinicName} · {branchName}</strong>
            <span className="caption muted">{me?.user.firstName} {me?.user.lastName}</span>
          </header>
          <SimulationBanner />
          <main id="main" className="content" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </BranchProvider>
  );
}
