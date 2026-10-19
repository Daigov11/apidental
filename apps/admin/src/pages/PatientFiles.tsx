import { useState, type FormEvent } from 'react';
import { Download, FileUp, Trash2 } from 'lucide-react';
import { ApiError, get, post, postForm } from '../api/client';
import type { AttachmentRow } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { downloadFile } from '../lib/download';
import { fmtDate } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Badge, EmptyState, ErrorState, Loading, errorText, useToast } from '../ui/feedback';
import { Dialog, ReasonDialog } from '../ui/overlays';

const CLINICAL = ['XRAY', 'CLINICAL_PHOTO', 'STUDY', 'OTHER_CLINICAL'];
const CATEGORY: Record<string, string> = {
  XRAY: 'Radiografía', CLINICAL_PHOTO: 'Fotografía clínica', STUDY: 'Estudio o examen', OTHER_CLINICAL: 'Otro documento clínico',
  CONSENT: 'Consentimiento', IDENTITY_DOCUMENT: 'Documento de identidad', OTHER_ADMINISTRATIVE: 'Otro documento administrativo',
};
const MAX_BYTES = 10 * 1024 * 1024;
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Radiografías, fotografías, estudios y documentos del paciente. Los archivos solo se obtienen con la sesión; no hay enlaces públicos. */
export function PatientFiles({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const files = useAsync(() => get<AttachmentRow[]>(`/patients/${patientId}/attachments`), [patientId]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AttachmentRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canClinical = can('clinical:write');
  const canAdmin = can('attachment:write');
  const categories = [...(canClinical ? CLINICAL : []), ...(canAdmin ? ['CONSENT', 'IDENTITY_DOCUMENT', 'OTHER_ADMINISTRATIVE'] : [])];
  const canChange = (a: AttachmentRow) => (CLINICAL.includes(a.category) ? canClinical : canAdmin);
  const download = async (a: AttachmentRow) => {
    setBusy(a.id);
    try { await downloadFile(`/patients/${patientId}/attachments/${a.id}/download`, {}, a.originalName); } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  };
  return (
    <section className="card" aria-labelledby="files-h" style={{ marginTop: 'var(--space-6)' }}>
      <div className="card-head">
        <h2 id="files-h" className="h3">Documentos y estudios</h2>
        {categories.length > 0 && <Button variant="secondary" size="sm" icon={<FileUp size={16} aria-hidden="true" />} onClick={() => setAdding(true)}>Adjuntar archivo</Button>}
      </div>
      {files.loading && !files.data && <Loading rows={2} />}
      {files.error != null && <ErrorState error={files.error} onRetry={files.reload} />}
      {files.data?.length === 0 && <EmptyState title="Todavía no hay archivos">Adjunte radiografías, fotografías clínicas, estudios u otros documentos del paciente (PDF, JPG, PNG o WebP, hasta 10 MB).</EmptyState>}
      {files.data && files.data.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-4)' }}>
          {files.data.map((a) => (
            <li key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span>
                <strong>{a.originalName}</strong> <Badge tone={CLINICAL.includes(a.category) ? 'info' : 'neutral'}>{CATEGORY[a.category] ?? a.category}</Badge><br />
                <span className="caption muted">{fmtDate(a.uploadedAt)} · {size(a.sizeBytes)}{a.description ? ` · ${a.description}` : ''}</span>
              </span>
              <span className="chip-row">
                <Button size="sm" icon={<Download size={16} aria-hidden="true" />} loading={busy === a.id} loadingText="Descargando…" aria-label={`Descargar ${a.originalName}`} onClick={() => void download(a)}>Descargar</Button>
                {canChange(a) && <Button size="sm" variant="tertiary" icon={<Trash2 size={16} aria-hidden="true" />} aria-label={`Eliminar ${a.originalName}`} onClick={() => setRemoving(a)}>Eliminar</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding && <UploadDialog patientId={patientId} categories={categories} onClose={() => setAdding(false)} onDone={() => { setAdding(false); toast.success('Archivo adjuntado.'); files.reload(); }} />}
      {removing && (
        <ReasonDialog
          title="Eliminar archivo" danger confirmLabel="Eliminar archivo" example="Se subió al paciente equivocado"
          explain={`«${removing.originalName}» dejará de mostrarse. El registro se conserva para auditoría.`}
          onClose={() => setRemoving(null)}
          onConfirm={async (reason) => { await post(`/patients/${patientId}/attachments/${removing.id}/remove`, { reason }); setRemoving(null); toast.success('Archivo eliminado.'); files.reload(); }}
        />
      )}
    </section>
  );
}

function UploadDialog({ patientId, categories, onClose, onDone }: { patientId: string; categories: string[]; onClose: () => void; onDone: () => void }) {
  const [category, setCategory] = useState(categories[0] ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileError = file && file.size > MAX_BYTES ? 'El archivo supera los 10 MB.' : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Elija el archivo que desea adjuntar.'); return; }
    if (fileError) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('category', category);
    if (description.trim()) form.append('description', description.trim());
    form.append('file', file);
    try { await postForm(`/patients/${patientId}/attachments`, form); onDone(); } catch (err) {
      setError(err instanceof ApiError && err.code === 'DUPLICATE_FILE' ? 'Este mismo archivo ya está cargado para el paciente.' : errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Adjuntar archivo" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button type="submit" form="upload-form" variant="primary" loading={busy} loadingText="Subiendo…">Adjuntar</Button></>}
    >
      <form id="upload-form" onSubmit={(e) => void submit(e)} noValidate style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <SelectField label="Tipo de archivo" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c} value={c}>{CATEGORY[c]}</option>)}
        </SelectField>
        <TextField label="Archivo" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" help="PDF, JPG, PNG o WebP, hasta 10 MB." error={fileError} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <TextField label="Descripción" optional value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Ejemplo: Panorámica inicial" />
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
