import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ClipboardList, Info, OctagonAlert, Plus, Smile } from 'lucide-react';
import { api, ApiError, get } from '../api/client';
import type { Charge, PatientDetail, Sheet } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { fmtDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { TextAreaField } from '../ui/fields';
import { Alert, Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { ReasonDialog } from '../ui/overlays';
import { OdontogramCanvas, useOdontogram } from './odontogram/useOdontogram';
import { AllergyDialog, CLOSE_BLOCKERS, ConfirmDialog, DiagnosisDialog, PasswordDialog, ProcedureDialog } from './VisitSheetParts';

const SEV = { CRITICAL: { tone: 'danger', Icon: OctagonAlert, label: 'Importante' }, WARNING: { tone: 'warning', Icon: AlertTriangle, label: 'Atención' }, INFO: { tone: 'info', Icon: Info, label: 'Información' } } as const;

type Dlg =
  | { k: 'allergy' } | { k: 'dx'; d?: Sheet['diagnoses'][number] } | { k: 'dx-off' | 'dx-on'; d: Sheet['diagnoses'][number] }
  | { k: 'proc' } | { k: 'proc-cancel'; p: Sheet['procedures'][number] }
  | { k: 'ev-close' | 'ev-discard' | 'ev-correct' } | { k: 'visit-close' };

/** Ficha de atención de una visita. Solo el odontólogo responsable (con la visita abierta) puede registrar; el resto la ve en lectura. */
export function VisitSheetPage() {
  const { id = '', visitId = '' } = useParams();
  const toast = useToast();
  const sheet = useAsync(() => get<Sheet>(`/patients/${id}/clinical/visits/${visitId}/sheet`), [id, visitId]);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const { me, can } = useAuth();
  const od = useOdontogram(id);
  // Datos de identificación para la tarjeta del paciente; si el perfil no puede leerlos, la tarjeta se arma sin documento.
  const person = useAsync(() => get<PatientDetail>(`/patients/${id}`).catch(() => null), [id]);
  if (sheet.loading && !sheet.data) return <Loading rows={5} label="Cargando la ficha de atención" />;
  if (sheet.error != null) return <ErrorState error={sheet.error} onRetry={sheet.reload} />;
  const s = sheet.data;
  if (!s) return null;
  const A = s.actions;
  const open = s.visit.status === 'OPEN';
  const base = `/patients/${id}/clinical`;
  /** Ejecuta una escritura; ante un conflicto de versión recarga la ficha para que se vea lo vigente. */
  const commit = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) sheet.reload();
      throw e;
    }
    setDlg(null);
    sheet.reload();
    toast.success(ok);
  };
  const close = () => setDlg(null);
  const blockers = (A.closeVisitBlockedBy ?? []).map((c) => CLOSE_BLOCKERS[c] ?? 'Hay un pendiente que impide cerrar la visita.');

  const editable = !A.readOnly && open;
  const doc = person.data?.identifiers[0];
  const initials = s.patient.fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  const findings = [
    ...s.diagnoses.map((d) => ({ key: `d-${d.id}`, kind: 'Diagnóstico' as const, d })),
    ...s.procedures.map((p) => ({ key: `p-${p.id}`, kind: 'Procedimiento' as const, p })),
  ];

  return (
    <>
      <p><Link to={`/pacientes/${id}`}>‹ {s.patient.fullName}</Link></p>
      <div className="page-head">
        <h1>Ficha de atención</h1>
        <Badge tone={open ? 'info' : 'success'}>{s.visit.statusLabel}</Badge>
      </div>

      <div className="ficha">
        <aside className="ficha-side" aria-label="Paciente">
          <section className="card ficha-person" aria-labelledby="pt-h">
            <div className="ficha-avatar" aria-hidden="true">{initials}</div>
            <h2 id="pt-h" className="h3">{s.patient.fullName}</h2>
            <p className="muted">{s.patient.age ?? '—'} años{s.patient.isMinor ? ' · menor de edad' : ''}</p>
            <dl className="ficha-facts">
              <div><dt>Documento</dt><dd>{doc ? `${doc.type} ${doc.number}` : '—'}</dd></div>
              <div><dt>Sede</dt><dd>{me?.context?.branch?.name ?? '—'}</dd></div>
              <div><dt>Visita</dt><dd>{s.visit.number} · {fmtDateTime(s.visit.startedAt)}</dd></div>
            </dl>
          </section>
          <nav className="ficha-nav" aria-label="Más información del paciente">
            <Link to={`/pacientes/${id}`}><ClipboardList size={18} aria-hidden="true" /> Ficha del paciente</Link>
            <Link to={`/pacientes/${id}/odontograma`}><Smile size={18} aria-hidden="true" /> Odontograma completo</Link>
            <Link to={`/pacientes/${id}#atencion-clinica`}><ClipboardList size={18} aria-hidden="true" /> Historial de visitas</Link>
          </nav>
        </aside>

        <div className="ficha-main">
          <section className="ficha-alerts" aria-labelledby="alerts-h">
            <h2 id="alerts-h" className="sr-only">Alertas</h2>
            {s.alerts.items.map((a) => {
              const sev = SEV[a.severity];
              return <Alert key={a.id} tone={sev.tone} title={`${sev.label}: ${a.label}`} />;
            })}
            <Alert
              tone={s.allergyAssessment.status === 'ALLERGIES_RECORDED' ? 'warning' : 'info'}
              title={s.allergyAssessment.label}
              action={editable ? <Button size="sm" onClick={() => setDlg({ k: 'allergy' })}>{s.allergyAssessment.status === 'NOT_ASKED' ? 'Registrar evaluación' : 'Actualizar'}</Button> : undefined}
            />
            <Alert tone={s.consent.state === 'GRANTED' ? 'success' : 'warning'} title={s.consent.label}>
              {s.consent.state !== 'GRANTED' && !A.readOnly && <span className="caption">Hoy el consentimiento clínico no se registra desde el panel: pida a recepción o administración que lo registre (se hace por la API).</span>}
            </Alert>
          </section>

          <section className="card" aria-labelledby="od-h">
            <div className="card-head">
              <h2 id="od-h" className="h3">Odontograma</h2>
              {od.official && <span className="caption muted">Versión {od.official.version} · {od.official.stateLabel}</span>}
            </div>
            {od.view.loading && !od.view.data ? <Loading rows={2} label="Cargando el odontograma" /> : od.view.error != null ? <ErrorState error={od.view.error} onRetry={od.view.reload} /> : (
              <OdontogramCanvas patientId={id} od={od} canWrite={editable && can('clinical:write')} embedded />
            )}
            <p className="caption muted" style={{ marginTop: 'var(--space-3)' }}>{s.odontogram.formatNotice}</p>
          </section>

          <section className="card" aria-labelledby="hall-h">
            <div className="card-head">
              <h2 id="hall-h" className="h3">Hallazgos</h2>
              <span className="row-actions">
                {A.canAddDiagnosis && <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setDlg({ k: 'dx' })}>Agregar diagnóstico</Button>}
                {A.canAddProcedure && <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setDlg({ k: 'proc' })}>Agregar procedimiento</Button>}
              </span>
            </div>
            {findings.length === 0 ? <EmptyState title="Sin diagnósticos ni procedimientos en esta visita" /> : (
              <div className="table-wrap table-cards">
                <table>
                  <caption className="sr-only">Diagnósticos y procedimientos de la visita</caption>
                  <thead><tr><th scope="col">Tipo</th><th scope="col">Detalle</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
                  <tbody>
                    {findings.map((f) => 'd' in f ? (
                      <tr key={f.key}>
                        <td data-label="Tipo">{f.kind}</td>
                        <td data-label="Detalle">{f.d.description}</td>
                        <td data-label="Estado">{f.d.certaintyLabel} · {f.d.statusLabel}</td>
                        <td data-label="Acciones">
                          {A.canAddDiagnosis ? (
                            <span className="row-actions">
                              <Button size="sm" onClick={() => setDlg({ k: 'dx', d: f.d })}>Corregir</Button>
                              {f.d.status === 'INACTIVE' ? <Button size="sm" onClick={() => setDlg({ k: 'dx-on', d: f.d })}>Reactivar</Button> : <Button size="sm" onClick={() => setDlg({ k: 'dx-off', d: f.d })}>Retirar</Button>}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    ) : (
                      <tr key={f.key}>
                        <td data-label="Tipo">{f.kind}</td>
                        <td data-label="Detalle">
                          <strong>{f.p.name}</strong>
                          {f.p.notes && <><br /><span className="caption">{f.p.notes}</span></>}
                          {f.p.closeBlockedMessage && <><br /><span className="caption" style={{ color: 'var(--state-warning-fg)' }}>{f.p.closeBlockedMessage}</span></>}
                        </td>
                        <td data-label="Estado">{f.p.statusLabel}</td>
                        <td data-label="Acciones">
                          {A.canAddProcedure && f.p.status === 'OPEN' ? (
                            <span className="row-actions">
                              <Button size="sm" variant="primary" disabled={!f.p.canClose} onClick={() => void commit(() => api('POST', `${base}/procedures/${f.p.id}/close`, { body: { expectedVersion: f.p.version ?? 1 } }), 'Procedimiento cerrado.').catch((e) => toast.error(errorText(e)))}>Marcar realizado</Button>
                              <Button size="sm" onClick={() => setDlg({ k: 'proc-cancel', p: f.p })}>Cancelar</Button>
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="ficha-aside" aria-label="Cobro y evolución">
          {can('charge:read') && <BillingSummary patientId={id} />}
          <EvolutionCard key={s.evolution?.etag ?? 'none'} s={s} onSave={(body, followUp) => commit(() => api('PUT', `${base}/visits/${visitId}/evolution`, { body: { body, ...(followUp ? { followUp } : {}), ...(s.evolution?.etag && s.evolution.state === 'DRAFT' ? { expectedEtag: s.evolution.etag } : {}) } }), 'Borrador guardado.')} onAction={(k) => setDlg({ k })} />
          {editable && (
            <section className="card" aria-labelledby="cv-h">
              <h2 id="cv-h" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Terminar la atención</h2>
              {blockers.length > 0 && <Alert tone="warning" title="Aún no puede cerrar la visita">{blockers.map((b) => <p key={b}>{b}</p>)}</Alert>}
              <Button variant="primary" disabled={!A.canCloseVisit} onClick={() => setDlg({ k: 'visit-close' })}>Cerrar la visita</Button>
            </section>
          )}
        </aside>
      </div>
      <p className="caption muted" style={{ marginTop: 'var(--space-5)' }}>{s.notice}</p>

      {dlg?.k === 'allergy' && <AllergyDialog patientId={id} assessment={s.allergyAssessment} commit={commit} onClose={close} />}
      {dlg?.k === 'dx' && <DiagnosisDialog patientId={id} visitId={visitId} current={dlg.d} commit={commit} onClose={close} />}
      {(dlg?.k === 'dx-off' || dlg?.k === 'dx-on') && (
        <ReasonDialog
          title={dlg.k === 'dx-off' ? 'Retirar diagnóstico' : 'Reactivar diagnóstico'}
          explain={dlg.k === 'dx-off' ? 'El diagnóstico deja de aplicar, pero se conserva en el historial.' : 'El diagnóstico vuelve a aplicar.'}
          confirmLabel={dlg.k === 'dx-off' ? 'Retirar' : 'Reactivar'}
          example="Se descartó con la radiografía"
          onClose={close}
          onConfirm={(reason) => commit(() => api('POST', `${base}/diagnoses/${dlg.d.id}/${dlg.k === 'dx-off' ? 'deactivate' : 'reactivate'}`, { body: { expectedVersion: dlg.d.version ?? 1, reason } }), dlg.k === 'dx-off' ? 'Diagnóstico retirado.' : 'Diagnóstico reactivado.')}
        />
      )}
      {dlg?.k === 'proc' && <ProcedureDialog patientId={id} visitId={visitId} commit={commit} onClose={close} />}
      {dlg?.k === 'proc-cancel' && (
        <ReasonDialog
          title="Cancelar procedimiento" explain="El procedimiento queda cancelado y se conserva en el historial." confirmLabel="Cancelar procedimiento" danger example="El paciente decidió no realizarlo hoy"
          onClose={close}
          onConfirm={(reason) => commit(() => api('POST', `${base}/procedures/${dlg.p.id}/cancel`, { body: { expectedVersion: dlg.p.version ?? 1, reason } }), 'Procedimiento cancelado.')}
        />
      )}
      {dlg?.k === 'ev-close' && s.evolution?.etag && (
        <PasswordDialog
          title="Cerrar la evolución" confirmLabel="Cerrar evolución"
          explain="Al cerrarla ya no se edita; solo se podrá corregir dejando el motivo. Confirme con su contraseña."
          onClose={close}
          onConfirm={(password) => commit(() => api('POST', `${base}/visits/${visitId}/evolution/close`, { body: { expectedEtag: s.evolution!.etag, password } }), 'Evolución cerrada.')}
        />
      )}
      {dlg?.k === 'ev-discard' && s.evolution?.etag && (
        <ReasonDialog
          title="Descartar el borrador" explain="Se descarta el borrador de la evolución; se conserva el registro del descarte." confirmLabel="Descartar" danger example="Se escribió en la visita equivocada"
          onClose={close}
          onConfirm={(reason) => commit(() => api('POST', `${base}/visits/${visitId}/evolution/discard`, { body: { expectedEtag: s.evolution!.etag, reason } }), 'Borrador descartado.')}
        />
      )}
      {dlg?.k === 'ev-correct' && s.evolution?.etag && (
        <CorrectEvolution evolution={s.evolution} onClose={close} onConfirm={(body, followUp, reason, password) => commit(() => api('POST', `${base}/visits/${visitId}/evolution/correct`, { body: { expectedEtag: s.evolution!.etag, reason, body, followUp: followUp || null, password } }), 'Evolución corregida.')} />
      )}
      {dlg?.k === 'visit-close' && (
        <ConfirmDialog
          title="Cerrar la visita" confirmLabel="Cerrar visita" onClose={close}
          explain="La visita se cierra y ya no se agregan diagnósticos, procedimientos ni evolución. ¿Terminó la atención?"
          onConfirm={() => commit(() => api('POST', `${base}/visits/${visitId}/close`, { body: { expectedVersion: s.visit.version ?? 1 } }), 'Visita cerrada.')}
        />
      )}
    </>
  );
}

/** Resumen de cobros del paciente; solo para perfiles con permiso de caja, y solo si hay cobros. */
function BillingSummary({ patientId }: { patientId: string }) {
  const charges = useAsync(() => get<Charge[]>('/billing/charges', { patientId, limit: 50 }).catch(() => [] as Charge[]), [patientId]);
  const list = (charges.data ?? []).filter((c) => c.status !== 'VOIDED');
  if (list.length === 0) return null;
  const sum = (f: (c: Charge) => boolean) => list.filter(f).reduce((t, c) => t + c.amountCents, 0);
  const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;
  return (
    <section className="card ficha-bill" aria-labelledby="bill-h">
      <h2 id="bill-h" className="h3" style={{ marginBottom: 'var(--space-4)' }}>Cobros del paciente</h2>
      <dl className="ficha-facts">
        <div><dt>Total</dt><dd>{money(sum(() => true))}</dd></div>
        <div><dt>Pagado</dt><dd>{money(sum((c) => c.status === 'PAID'))}</dd></div>
        <div><dt>Por pagar</dt><dd><strong>{money(sum((c) => c.status === 'PENDING'))}</strong></dd></div>
      </dl>
    </section>
  );
}

function EvolutionCard({ s, onSave, onAction }: { s: Sheet; onSave: (body: string, followUp: string) => Promise<void>; onAction: (k: 'ev-close' | 'ev-discard' | 'ev-correct') => void }) {
  const ev = s.evolution;
  const [body, setBody] = useState(ev?.body ?? '');
  const [followUp, setFollowUp] = useState(ev?.followUp ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = s.actions.canWriteEvolution === true;
  const dirty = body !== (ev?.body ?? '') || followUp !== (ev?.followUp ?? '');
  const save = async () => {
    if (!body.trim()) { setError('Escriba la evolución.'); return; }
    setBusy(true);
    setError(null);
    try { await onSave(body.trim(), followUp.trim()); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="ev-h">
      <div className="card-head"><h2 id="ev-h" className="h3">Nota de evolución</h2>{ev && <Badge tone={ev.state === 'DRAFT' ? 'warning' : 'success'}>{ev.stateLabel}</Badge>}</div>
      {editing ? (
        <>
          <TextAreaField label="Evolución de la visita" value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} rows={5} help="Escriba lo que observó y realizó. Se guarda como borrador hasta que la cierre." />
          <TextAreaField label="Seguimiento" optional value={followUp} onChange={(e) => setFollowUp(e.target.value)} maxLength={2000} rows={2} />
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="chip-row">
            <Button variant="primary" loading={busy} loadingText="Guardando…" disabled={!dirty} onClick={() => void save()}>Guardar borrador</Button>
            {ev?.state === 'DRAFT' && s.actions.canCloseEvolution && <Button disabled={dirty} onClick={() => onAction('ev-close')}>Cerrar evolución</Button>}
            {ev?.state === 'DRAFT' && <Button onClick={() => onAction('ev-discard')}>Descartar borrador</Button>}
          </div>
          {ev?.state === 'DRAFT' && dirty && <p className="caption muted" style={{ marginTop: 'var(--space-3)' }}>Guarde el borrador antes de cerrarlo.</p>}
        </>
      ) : !ev ? <EmptyState title="Aún no hay evolución">El odontólogo la registrará durante la atención.</EmptyState> : ev.contentHidden ? <p className="muted">El contenido no está disponible para su perfil.</p> : (
        <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{ev.body}</p>
          {ev.followUp && <p className="muted" style={{ marginTop: 'var(--space-4)' }}><strong>Seguimiento:</strong> {ev.followUp}</p>}
          {s.actions.canCorrectEvolution && <Button style={{ marginTop: 'var(--space-4)' }} onClick={() => onAction('ev-correct')}>Corregir evolución</Button>}
        </>
      )}
    </section>
  );
}

function CorrectEvolution({ evolution, onClose, onConfirm }: { evolution: NonNullable<Sheet['evolution']>; onClose: () => void; onConfirm: (body: string, followUp: string, reason: string, password: string) => Promise<void> }) {
  const [body, setBody] = useState(evolution.body ?? '');
  const [followUp, setFollowUp] = useState(evolution.followUp ?? '');
  return (
    <PasswordDialog
      title="Corregir la evolución" confirmLabel="Guardar corrección" withReason onClose={onClose}
      explain="La versión anterior se conserva en el historial. Indique el motivo y confirme con su contraseña."
      extra={<><TextAreaField label="Evolución" value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} rows={5} /><TextAreaField label="Seguimiento" optional value={followUp} onChange={(e) => setFollowUp(e.target.value)} maxLength={2000} rows={2} /></>}
      onConfirm={(password, reason) => onConfirm(body.trim(), followUp.trim(), reason, password)}
    />
  );
}
