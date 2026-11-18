import { useEffect, useRef, useState } from 'react';
import { ExternalLink, ImageUp, Plus, Save, Trash2 } from 'lucide-react';
import { api, get, postForm, put } from '../api/client';
import { useAsync } from '../lib/useAsync';
import { Button } from '../ui/Button';
import { TextAreaField, TextField } from '../ui/fields';
import { Alert, ErrorState, Loading, errorText, useToast } from '../ui/feedback';

interface Step { title: string; text: string }
interface Faq { question: string; answer: string }
interface Sections { services: boolean; howItWorks: boolean; branches: boolean; faq: boolean }
export interface SiteSettings {
  clinicName: string;
  displayName: string;
  primaryColor: string;
  logoUrl: string | null;
  heroEyebrow: string;
  heroTitle: string;
  heroLead: string;
  phone: string;
  whatsapp: string;
  contactEmail: string;
  steps: Step[];
  faqs: Faq[];
  privacyText: string;
  sections: Sections;
}
type Form = Omit<SiteSettings, 'clinicName' | 'logoUrl'>;

/** Textos que la página muestra cuando el campo queda vacío (apps/site/index.html). */
const DEFAULTS = {
  heroEyebrow: 'Atención odontológica',
  heroTitle: 'Solicite su cita dental en línea',
  heroLead: 'Elija el servicio y un horario con disponibilidad. La clínica revisa su solicitud y se comunica con usted para confirmarla.',
  privacyText: 'Le pedimos su nombre, un celular y, si desea, documento y correo, solo para gestionar su solicitud de cita…',
  steps: [
    { title: 'Elige servicio y horario', text: 'Seleccione la sede, el servicio y uno de los horarios disponibles, y déjenos sus datos de contacto.' },
    { title: 'Recepción confirma', text: 'El personal de la clínica revisa su solicitud y la asigna a un odontólogo, o le propone otro horario si hace falta.' },
    { title: 'Le contactamos', text: 'Nos comunicamos con usted al celular que indique para confirmar su cita.' },
  ],
};
const SECTION_LABELS: [keyof Sections, string][] = [
  ['services', 'Servicios'],
  ['howItWorks', 'Cómo funciona'],
  ['branches', 'Sedes'],
  ['faq', 'Preguntas frecuentes'],
];
const MAX_STEPS = 4;
const MAX_FAQS = 12;
const LOGO_MAX = 512 * 1024;

const toForm = (s: SiteSettings): Form => {
  const { clinicName: _c, logoUrl: _l, ...rest } = s;
  return rest;
};

/** Personalizar la página pública donde los pacientes solicitan su cita (solo administración de la clínica). */
export function SiteSettingsPage() {
  const toast = useToast();
  const st = useAsync(() => get<SiteSettings>('/site-settings'), []);
  const [form, setForm] = useState<Form | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (st.data) { setForm(toForm(st.data)); setLogoUrl(st.data.logoUrl); }
  }, [st.data]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true); setError(null);
    try {
      const body = {
        ...form,
        steps: form.steps.filter((s) => s.title.trim()),
        faqs: form.faqs.filter((f) => f.question.trim() && f.answer.trim()),
      };
      const r = await put<SiteSettings>('/site-settings', body);
      setForm(toForm(r)); setLogoUrl(r.logoUrl);
      toast.success('Página web actualizada.');
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  };

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > LOGO_MAX) { setError('El logo no debe pasar de 512 KB.'); return; }
    setLogoBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await postForm<SiteSettings>('/site-settings/logo', fd);
      setLogoUrl(r.logoUrl);
      toast.success('Logo actualizado.');
    } catch (e) { setError(errorText(e)); }
    finally { setLogoBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const removeLogo = async () => {
    setLogoBusy(true); setError(null);
    try {
      const r = await api<SiteSettings>('DELETE', '/site-settings/logo');
      setLogoUrl(r.logoUrl);
      toast.success('Logo quitado.');
    } catch (e) { setError(errorText(e)); }
    finally { setLogoBusy(false); }
  };

  const steps = form && form.steps.length ? form.steps : null;
  const editSteps = (fn: (s: Step[]) => Step[]) => set('steps', fn(steps ?? DEFAULTS.steps.map((s) => ({ ...s }))));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Página web</h1>
          <p className="muted">Personalice la página pública donde los pacientes solicitan su cita. Si deja un campo vacío, se usa el texto de siempre.</p>
        </div>
        <div className="chip-row">
          <a className="btn btn-secondary btn-sm" href="/" target="_blank" rel="noopener"><ExternalLink size={16} aria-hidden="true" /> Ver página</a>
          <Button variant="primary" size="sm" icon={<Save size={16} aria-hidden="true" />} disabled={!form} loading={saving} loadingText="Guardando…" onClick={() => void save()}>Guardar cambios</Button>
        </div>
      </div>

      {st.loading && !form && <Loading rows={4} />}
      {st.error != null && <ErrorState error={st.error} onRetry={st.reload} />}
      {error && <Alert tone="danger">{error}</Alert>}

      {form && st.data && (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ display: 'grid', gap: 'var(--space-5)', maxWidth: 820 }}>
          <section className="card" aria-labelledby="site-brand">
            <div className="card-head"><h2 id="site-brand" className="h3">Marca</h2></div>
            <TextField label="Nombre que se muestra" optional maxLength={120} placeholder={st.data.clinicName} help={`Vacío = «${st.data.clinicName}».`} value={form.displayName} onChange={(e) => set('displayName', e.target.value)} />
            <div className="field">
              <label className="field-label" htmlFor="site-color">Color principal <span className="field-optional">(opcional)</span></label>
              <div className="chip-row" style={{ alignItems: 'center' }}>
                <input id="site-color" type="color" value={form.primaryColor || '#0f7889'} onChange={(e) => set('primaryColor', e.target.value)} style={{ width: 56, height: 40, padding: 0, border: 'none', background: 'none' }} />
                <span className="tabular">{form.primaryColor || 'Color de siempre'}</span>
                {form.primaryColor && <Button size="sm" variant="tertiary" onClick={() => set('primaryColor', '')}>Usar el de siempre</Button>}
              </div>
            </div>
            <div className="field">
              <span className="field-label">Logo <span className="field-optional">(opcional)</span></span>
              <div className="chip-row" style={{ alignItems: 'center' }}>
                {logoUrl
                  ? <img src={logoUrl} alt="Logo actual" style={{ height: 48, maxWidth: 180, objectFit: 'contain', background: '#fff', borderRadius: 6, padding: 4 }} />
                  : <span className="muted">Sin logo propio</span>}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void uploadLogo(e.target.files?.[0])} />
                <Button size="sm" icon={<ImageUp size={16} aria-hidden="true" />} loading={logoBusy} loadingText="Subiendo…" onClick={() => fileRef.current?.click()}>{logoUrl ? 'Cambiar logo' : 'Subir logo'}</Button>
                {logoUrl && <Button size="sm" variant="tertiary" icon={<Trash2 size={16} aria-hidden="true" />} disabled={logoBusy} onClick={() => void removeLogo()}>Quitar</Button>}
              </div>
              <p className="field-help">PNG, JPG o WebP de hasta 512 KB. El logo se guarda en cuanto lo sube.</p>
            </div>
          </section>

          <section className="card" aria-labelledby="site-hero">
            <div className="card-head"><h2 id="site-hero" className="h3">Portada</h2></div>
            <TextField label="Texto sobre el título" optional maxLength={60} placeholder={DEFAULTS.heroEyebrow} value={form.heroEyebrow} onChange={(e) => set('heroEyebrow', e.target.value)} />
            <TextField label="Título" optional maxLength={120} placeholder={DEFAULTS.heroTitle} value={form.heroTitle} onChange={(e) => set('heroTitle', e.target.value)} />
            <TextAreaField label="Descripción" optional maxLength={400} placeholder={DEFAULTS.heroLead} value={form.heroLead} onChange={(e) => set('heroLead', e.target.value)} />
          </section>

          <section className="card" aria-labelledby="site-contact">
            <div className="card-head"><h2 id="site-contact" className="h3">Contacto</h2></div>
            <p className="muted">Se muestra en la portada y al pie de la página. Con WhatsApp aparece además un botón verde para escribir a la clínica.</p>
            <div className="row-2">
              <TextField label="Teléfono" optional maxLength={40} inputMode="tel" placeholder="(01) 555 1234" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              <TextField label="WhatsApp" optional maxLength={20} inputMode="tel" placeholder="930 607 986" help="9 dígitos (Perú) o con código de país." value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} />
            </div>
            <TextField label="Correo" optional type="email" maxLength={254} value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
          </section>

          <section className="card" aria-labelledby="site-sections">
            <div className="card-head"><h2 id="site-sections" className="h3">Secciones visibles</h2></div>
            <p className="muted">El formulario para solicitar la cita siempre se muestra.</p>
            {SECTION_LABELS.map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={form.sections[k]} onChange={(e) => set('sections', { ...form.sections, [k]: e.target.checked })} /> {label}
              </label>
            ))}
          </section>

          <section className="card" aria-labelledby="site-steps">
            <div className="card-head">
              <h2 id="site-steps" className="h3">Cómo funciona</h2>
              {steps && <Button size="sm" variant="tertiary" onClick={() => set('steps', [])}>Volver a los pasos de siempre</Button>}
            </div>
            {!steps && <p className="muted">Se muestran los pasos de siempre. Edítelos para cambiarlos.</p>}
            {(steps ?? DEFAULTS.steps).map((s, i) => (
              <fieldset key={i} className="card" style={{ marginBottom: 'var(--space-3)' }}>
                <legend className="field-label">Paso {i + 1}</legend>
                <TextField label="Título" maxLength={80} value={s.title} onChange={(e) => editSteps((l) => l.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <TextAreaField label="Texto" maxLength={300} value={s.text} onChange={(e) => editSteps((l) => l.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                <Button size="sm" variant="tertiary" icon={<Trash2 size={16} aria-hidden="true" />} disabled={(steps ?? DEFAULTS.steps).length <= 1} onClick={() => editSteps((l) => l.filter((_, j) => j !== i))}>Quitar paso</Button>
              </fieldset>
            ))}
            <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} disabled={(steps ?? DEFAULTS.steps).length >= MAX_STEPS} onClick={() => editSteps((l) => [...l, { title: '', text: '' }])}>Agregar paso</Button>
          </section>

          <section className="card" aria-labelledby="site-faq">
            <div className="card-head"><h2 id="site-faq" className="h3">Preguntas frecuentes</h2></div>
            {form.faqs.length === 0 && <p className="muted">Se muestran las preguntas de siempre. Agregue las suyas para reemplazarlas.</p>}
            {form.faqs.map((f, i) => (
              <fieldset key={i} className="card" style={{ marginBottom: 'var(--space-3)' }}>
                <legend className="field-label">Pregunta {i + 1}</legend>
                <TextField label="Pregunta" maxLength={160} value={f.question} onChange={(e) => set('faqs', form.faqs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
                <TextAreaField label="Respuesta" maxLength={800} value={f.answer} onChange={(e) => set('faqs', form.faqs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} />
                <Button size="sm" variant="tertiary" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => set('faqs', form.faqs.filter((_, j) => j !== i))}>Quitar pregunta</Button>
              </fieldset>
            ))}
            <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} disabled={form.faqs.length >= MAX_FAQS} onClick={() => set('faqs', [...form.faqs, { question: '', answer: '' }])}>Agregar pregunta</Button>
          </section>

          <section className="card" aria-labelledby="site-privacy">
            <div className="card-head"><h2 id="site-privacy" className="h3">Aviso de privacidad</h2></div>
            <TextAreaField label="Texto del aviso" optional maxLength={1500} placeholder={DEFAULTS.privacyText} value={form.privacyText} onChange={(e) => set('privacyText', e.target.value)} />
          </section>

          <div className="chip-row">
            <Button type="submit" variant="primary" icon={<Save size={18} aria-hidden="true" />} loading={saving} loadingText="Guardando…">Guardar cambios</Button>
          </div>
        </form>
      )}
    </>
  );
}
