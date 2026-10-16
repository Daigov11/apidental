import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { AppShell } from './layout/AppShell';
import { AgendaPage } from './pages/Agenda';
import { CashPage } from './pages/Cash';
import { ChargePage } from './pages/Charge';
import { DocumentsPage } from './pages/Documents';
import { FotoclinicaPage } from './pages/Fotoclinica';
import { DashboardPage } from './pages/Dashboard';
import { ContextPage, LoginPage } from './pages/Login';
import { PatientDetailPage } from './pages/PatientDetail';
import { PatientsPage } from './pages/Patients';
import { RequestsPage } from './pages/Requests';
import { VisitSheetPage } from './pages/VisitSheet';
import { Loading } from './ui/feedback';

// El odontograma trae las plantillas anatómicas (~1 MB sin comprimir): se carga solo al abrirlo.
const OdontogramPage = lazy(() => import('./pages/Odontogram').then((m) => ({ default: m.OdontogramPage })));

export function App() {
  const { status } = useAuth();
  if (status === 'loading') return <main className="auth-page" id="main"><Loading label="Abriendo el panel" rows={2} /></main>;
  if (status === 'anonymous') return <LoginPage />;
  if (status === 'choose-context') return <ContextPage />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="agenda" element={<AgendaPage />} />
        <Route path="fotoclinica" element={<FotoclinicaPage />} />
        <Route path="caja" element={<CashPage />} />
        <Route path="caja/:id" element={<ChargePage />} />
        <Route path="comprobantes" element={<DocumentsPage />} />
        <Route path="solicitudes" element={<RequestsPage />} />
        <Route path="pacientes" element={<PatientsPage />} />
        <Route path="pacientes/:id" element={<PatientDetailPage />} />
        <Route path="pacientes/:id/atencion/:visitId" element={<VisitSheetPage />} />
        <Route path="pacientes/:id/odontograma" element={<Suspense fallback={<Loading label="Cargando el odontograma" rows={3} />}><OdontogramPage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
