import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search, Users } from 'lucide-react';
import { get } from '../api/client';
import type { PatientSummary } from '../api/types';
import { mobileFmt } from '../lib/format';
import { Button } from '../ui/Button';
import { TextField } from '../ui/fields';
import { Badge, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { useAsync } from '../lib/useAsync';
import { useAuth } from '../auth/AuthProvider';
import { CreatePatientDialog } from './CreatePatientDialog';

export function PatientsPage() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { can } = useAuth();
  const canCreate = can('patient:write');
  const list = useAsync(
    () => {
      if (!query) return Promise.resolve([] as PatientSummary[]);
      const digits = /^\d+$/.test(query);
      return get<PatientSummary[]>('/patients', digits ? (query.length >= 8 ? { identifier: query } : { phone: query }) : { name: query }, undefined).then((r) => r);
    },
    [query],
  );
  const submit = (e: FormEvent) => { e.preventDefault(); const q = text.trim(); setQuery(q.length >= 2 ? q : null); };

  return (
    <>
      <div className="page-head"><h1>Pacientes</h1>{canCreate && <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setCreating(true)}>Nuevo paciente</Button>}</div>
      <form className="toolbar" onSubmit={submit} role="search" aria-label="Buscar paciente">
        <div style={{ flex: '1 1 320px' }}>
          <TextField label="Buscar por DNI, nombre o celular" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ejemplo: 90000001 o Lucía" help="Escriba al menos 2 caracteres." />
        </div>
        <Button type="submit" variant="primary" icon={<Search size={18} aria-hidden="true" />}>Buscar</Button>
      </form>
      <div aria-live="polite">
        {list.loading && query && <Loading label="Buscando pacientes" />}
        {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}
        {!query && <EmptyState icon={<Users size={32} aria-hidden="true" />} title="Busque a un paciente">Escriba su DNI, nombre o celular para abrir su ficha.</EmptyState>}
        {query && !list.loading && !list.error && list.data?.length === 0 && <EmptyState title="Sin resultados" action={canCreate ? <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setCreating(true)}>Crear a «{query}»</Button> : undefined}>Revise el dato escrito o pruebe con otro. {canCreate ? 'Si no está registrado, créelo ahora.' : 'Si no está registrado, pida a recepción que lo cree.'}</EmptyState>}
        {list.data && list.data.length > 0 && (
          <div className="table-wrap table-cards">
            <table>
              <caption className="sr-only">Pacientes encontrados</caption>
              <thead><tr><th scope="col">Paciente</th><th scope="col">Documento</th><th scope="col">Edad</th><th scope="col">Celular</th><th scope="col">Estado</th></tr></thead>
              <tbody>
                {list.data.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Paciente"><Link className="row-link" to={`/pacientes/${p.id}`}>{p.fullName}</Link></td>
                    <td data-label="Documento" className="tabular">{p.identifiers[0] ? `${p.identifiers[0].type} ${p.identifiers[0].number}` : '—'}</td>
                    <td data-label="Edad">{p.age ?? '—'}</td>
                    <td data-label="Celular" className="tabular">{mobileFmt(p.primaryMobile)}</td>
                    <td data-label="Estado"><Badge tone={p.status === 'ACTIVE' ? 'success' : 'neutral'}>{p.status === 'ACTIVE' ? 'Activo' : 'Inactivo'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <CreatePatientDialog initialText={query ?? ''} onClose={() => setCreating(false)} onCreated={(p) => navigate(`/pacientes/${p.id}`)} />}
    </>
  );
}
