import { useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { BookOpen, CalendarDays, ChevronsLeft, ChevronsRight, FileText, Home, Inbox, LogOut, Repeat, Users, Wallet } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { BranchProvider } from '../lib/branch';
import { usePendingRequests } from '../lib/bookingRequests';
import { IntegrationsProvider, useIntegrations } from '../lib/integrations';
import { SimulationBanner } from '../ui/SimulationBanner';
import { Button } from '../ui/Button';
import logoBlanco from '../assets/brand/apimedical-blanco.png';
import mascota from '../assets/brand/mascota.png';

interface Item { to: string; label: string; icon: ReactNode; show: boolean; end?: boolean; badge?: number | null }

export function AppShell() {
  return (
    <IntegrationsProvider>
      <Shell />
    </IntegrationsProvider>
  );
}

const COLLAPSE_KEY = 'apidental.sidebar.collapsed';
const readCollapsed = (): boolean => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

function Shell() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => setCollapsed((c) => { const next = !c; try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* sin almacenamiento: no se recuerda */ } return next; });
  const { me, can, logout, switchContext } = useAuth();
  const { mode } = useIntegrations();
  const clinicName = me?.context?.clinic?.name ?? 'ApiDental';
  const branchName = me?.context?.branch?.name ?? 'Todas las sedes';
  const hasClinic = Boolean(me?.context?.clinic);
  const pending = usePendingRequests(hasClinic && can('appointment:manage'));
  // La ausencia de permiso oculta el módulo; nunca se muestra "deshabilitado".
  const items: Item[] = [
    { to: '/', label: 'Hoy', icon: <Home size={20} aria-hidden="true" />, show: true, end: true },
    { to: '/agenda', label: 'Agenda', icon: <CalendarDays size={20} aria-hidden="true" />, show: hasClinic && can('appointment:read') },
    { to: '/solicitudes', label: 'Solicitudes', icon: <Inbox size={20} aria-hidden="true" />, show: hasClinic && can('appointment:manage'), badge: pending },
    { to: '/pacientes', label: 'Pacientes', icon: <Users size={20} aria-hidden="true" />, show: hasClinic && (can('patient:read_basic') || can('patient:read')) },
    { to: '/caja', label: 'Caja', icon: <Wallet size={20} aria-hidden="true" />, show: hasClinic && mode === 'mock' && can('charge:read') },
    { to: '/comprobantes', label: 'Comprobantes', icon: <FileText size={20} aria-hidden="true" />, show: hasClinic && mode === 'mock' && can('billing:read') },
  ];
  return (
    <BranchProvider>
      <a className="skip-link" href="#main">Saltar al contenido</a>
      <div className={`shell${collapsed ? ' shell-collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-logo" src={logoBlanco} alt="APIMedical" />
            <img className="brand-mini" src={mascota} alt="" aria-hidden="true" />
            <span className="brand-sub">ApiDental<small>by Apiworking</small></span>
          </div>
          <button type="button" className="sidebar-toggle" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expandir el menú lateral' : 'Contraer el menú lateral'} title={collapsed ? 'Expandir el menú' : 'Contraer el menú'}>
            {collapsed ? <ChevronsRight size={20} aria-hidden="true" /> : <ChevronsLeft size={20} aria-hidden="true" />}
            <span className="nav-label">Contraer menú</span>
          </button>
          <nav aria-label="Principal" className="nav">
            {items.filter((i) => i.show).map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} title={i.label}>
                {i.icon}
                <span className="nav-label">{i.label}</span>
                {i.badge ? <span className="nav-badge" aria-hidden="true">{i.badge}</span> : null}
                {i.badge ? <span className="sr-only">{i.badge} pendientes</span> : null}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span className="label">{me?.user.firstName} {me?.user.lastName}</span>
            <a className="btn btn-tertiary btn-sm" href={`${import.meta.env.BASE_URL}guia/Guia-ApiDental.pdf`} target="_blank" rel="noopener" download="Guia-ApiDental.pdf"><BookOpen size={18} aria-hidden="true" /><span className="label">Guía de uso (PDF)</span></a>
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
