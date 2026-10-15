import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { AppShell } from './layout/AppShell';
import { AgendaPage } from './pages/Agenda';
import { DashboardPage } from './pages/Dashboard';
import { ContextPage, LoginPage } from './pages/Login';
import { OdontogramPage } from './pages/Odontogram';
import { PatientDetailPage } from './pages/PatientDetail';
import { PatientsPage } from './pages/Patients';
import { VisitSheetPage } from './pages/VisitSheet';
import { Loading } from './ui/feedback';

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
        <Route path="pacientes" element={<PatientsPage />} />
        <Route path="pacientes/:id" element={<PatientDetailPage />} />
        <Route path="pacientes/:id/atencion/:visitId" element={<VisitSheetPage />} />
        <Route path="pacientes/:id/odontograma" element={<OdontogramPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
