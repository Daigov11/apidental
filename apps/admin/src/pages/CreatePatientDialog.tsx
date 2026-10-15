import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, get, post } from '../api/client';
import type { PatientSummary } from '../api/types';
import { limaDate } from '../lib/format';
import { Button } from '../ui/Button';
import { SelectField, TextField } from '../ui/fields';
import { Alert, errorText } from '../ui/feedback';
import { Dialog } from '../ui/overlays';

interface Candidate { patientId: string; fullName: string; birthDate: string | null; reasons: string[]; confidence: string }
interface Check { identifierConflict: { id: string; fullName: string } | null; possibleDuplicates: Candidate[] }
interface Created { patient: PatientSummary; warnings?: string[] }

const REASON: Record<string, string> = {
  NAME_AND_BIRTHDATE: 'mismo nombre y fecha de nacimiento', NAME: 'mismo nombre', MOBILE: 'mismo celular', EMAIL: 'mismo correo',
};
const DOC_RULES = {
  DNI: { re: /^\d{8}$/, msg: 'El DNI tiene 8 dígitos.', inputMode: 'numeric' as const, max: 8 },
  CE: { re: /^[A-Za-z0-9]{6,20}$/, msg: 'El carné de extranjería tiene entre 6 y 20 letras o números.', inputMode: 'text' as const, max: 20 },
  PASSPORT: { re: /^[A-Za-z0-9]{6,20}$/, msg: 'El pasaporte tiene entre 6 y 20 letras o números.', inputMode: 'text' as const, max: 20 },
};

/** Del texto buscado deduce los primeros datos: 8 dígitos = DNI, otros dígitos = celular, texto = nombre. */
export function prefillFrom(text: string): { docNumber: string; mobile: string; firstName: string; lastName: string } {
  const q = text.trim();
  if (/^\d{8}$/.test(q)) return { docNumber: q, mobile: '', firstName: '', lastName: '' };
  if (/^\d+$/.test(q)) return { docNumber: '', mobile: q, firstName: '', lastName: '' };
  const [first = '', ...rest] = q.split(/\s+/);
  return { docNumber: '', mobile: '', firstName: first, lastName: rest.join(' ') };
}

/**
 * Alta de paciente. Antes de crear consulta si ya existe (mismo documento) o si hay coincidencias parecidas; en ambos
 * casos permite usar a la persona que ya está registrada. El sistema nunca fusiona ni bloquea por coincidencias suaves.
 */
/** Datos con los que se precarga el formulario (p. ej. los de una solicitud de cita). */
export interface PatientInitial { firstName?: string; lastName?: string; secondLastName?: string; docType?: 'DNI' | 'CE' | 'PASSPORT'; docNumber?: string; mobile?: string; email?: string }
interface Props { initialText?: string; initial?: PatientInitial; onCreated: (p: PatientSummary) => void; onClose: () => void }

/** Se dibuja fuera del formulario que lo abre (p. ej. «Nueva cita»): no se anidan formularios ni se mezclan sus envíos. */
export function CreatePatientDialog(props: Props) {
  return createPortal(<CreatePatientForm {...props} />, document.body);
}

function CreatePatientForm({ initialText = '', initial, onCreated, onClose }: Props) {
  const pre = { ...prefillFrom(initialText), ...initial };
  const [docType, setDocType] = useState<keyof typeof DOC_RULES>(initial?.docType ?? 'DNI');
  const [docNumber, setDocNumber] = useState(pre.docNumber ?? '');
  const [firstName, setFirstName] = useState(pre.firstName ?? '');
  const [lastName, setLastName] = useState(pre.lastName ?? '');
  const [secondLastName, setSecondLastName] = useState(initial?.secondLastName ?? '');
  const [birthDate, setBirthDate] = useState('');
  const [sex, setSex] = useState('');
  const [mobile, setMobile] = useState(pre.mobile ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);

  const rule = DOC_RULES[docType];
  const errs = {
    docNumber: docNumber && !rule.re.test(docNumber) ? rule.msg : null,
    firstName: firstName.trim() ? null : 'Escriba los nombres.',
    lastName: lastName.trim() ? null : 'Escriba el apellido paterno.',
    birthDate: birthDate && birthDate > limaDate() ? 'La fecha no puede ser futura.' : null,
    mobile: mobile && !/^9\d{8}$/.test(mobile.replace(/\s/g, '')) ? 'El celular tiene 9 dígitos y empieza con 9.' : null,
    email: email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'Escriba un correo válido.' : null,
  };
  const invalid = Object.values(errs).some(Boolean);
  const show = <K extends keyof typeof errs>(k: K) => (submitted ? errs[k] : null);

  const payload = () => ({
    firstName: firstName.trim(), lastName: lastName.trim(), ...(secondLastName.trim() ? { secondLastName: secondLastName.trim() } : {}),
    ...(birthDate ? { birthDate } : {}), ...(sex ? { sex } : {}),
    ...(docNumber ? { identifier: { type: docType, number: docNumber.trim() } } : {}),
    contacts: [
      ...(mobile ? [{ type: 'MOBILE', value: mobile.replace(/\s/g, ''), isPrimary: true }] : []),
      ...(email ? [{ type: 'EMAIL', value: email.trim() }] : []),
    ],
  });

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<Created>('/patients', payload());
      onCreated(res.patient);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setError('Ya existe un paciente con ese documento en la clínica. Búsquelo por su documento.');
      else setError(errorText(e));
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // los eventos de un portal suben por el árbol de React hasta el formulario que lo abrió
    setSubmitted(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      // La comprobación no recibe `contacts`: pide el celular y el correo como campos sueltos.
      const { contacts: _contacts, ...person } = payload();
      const found = await post<Check>('/patients/duplicate-check', { ...person, mobile: mobile.replace(/\s/g, '') || undefined, email: email.trim() || undefined });
      if (found.identifierConflict || found.possibleDuplicates.length > 0) { setCheck(found); setBusy(false); return; }
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    await create();
  };

  const useExisting = async (id: string) => {
    setBusy(true);
    try { onCreated(await get<PatientSummary>(`/patients/${id}`)); } catch (e) { setError(errorText(e)); setBusy(false); }
  };

  if (check) {
    const conflict = check.identifierConflict;
    return (
      <Dialog
        title={conflict ? 'Este paciente ya está registrado' : 'Puede que ya exista'}
        onClose={onClose}
        footer={conflict
          ? <Button onClick={onClose}>Cerrar</Button>
          : <><Button onClick={() => setCheck(null)} disabled={busy}>Volver</Button><Button variant="primary" loading={busy} loadingText="Creando…" onClick={() => void create()}>Crear de todos modos</Button></>}
      >
        {conflict
          ? <p>Ya existe <strong>{conflict.fullName}</strong> con ese documento. No se crea otra ficha.</p>
          : <p>Encontramos pacientes parecidos. Si es la misma persona, elíjala para no duplicar su ficha.</p>}
        <ul className="dup-list">
          {conflict && <li><strong>{conflict.fullName}</strong><Button size="sm" variant="primary" disabled={busy} onClick={() => void useExisting(conflict.id)}>Usar a este paciente</Button></li>}
          {!conflict && check.possibleDuplicates.map((c) => (
            <li key={c.patientId}>
              <span><strong>{c.fullName}</strong><br /><span className="caption muted">{c.reasons.map((r) => REASON[r] ?? r).join(', ')}</span></span>
              <Button size="sm" disabled={busy} onClick={() => void useExisting(c.patientId)}>Usar a este paciente</Button>
            </li>
          ))}
        </ul>
        {error && <p className="field-error" role="alert">{error}</p>}
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Nuevo paciente"
      onClose={onClose}
      footer={<><Button onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" form="new-patient-form" variant="primary" loading={busy} loadingText="Guardando…">Crear paciente</Button></>}
    >
      <form id="new-patient-form" onSubmit={(e) => void submit(e)} noValidate className="patient-form">
        <div className="row-2">
          <SelectField label="Documento" value={docType} onChange={(e) => { setDocType(e.target.value as keyof typeof DOC_RULES); setDocNumber(''); }}>
            <option value="DNI">DNI</option><option value="CE">Carné de extranjería</option><option value="PASSPORT">Pasaporte</option>
          </SelectField>
          <TextField label="Número" optional value={docNumber} inputMode={rule.inputMode} maxLength={rule.max} onChange={(e) => setDocNumber(docType === 'DNI' ? e.target.value.replace(/\D/g, '') : e.target.value)} error={show('docNumber')} />
        </div>
        <TextField label="Nombres" value={firstName} maxLength={100} autoComplete="off" onChange={(e) => setFirstName(e.target.value)} error={show('firstName')} />
        <div className="row-2">
          <TextField label="Apellido paterno" value={lastName} maxLength={100} autoComplete="off" onChange={(e) => setLastName(e.target.value)} error={show('lastName')} />
          <TextField label="Apellido materno" optional value={secondLastName} maxLength={100} autoComplete="off" onChange={(e) => setSecondLastName(e.target.value)} />
        </div>
        <div className="row-2">
          <TextField label="Fecha de nacimiento" optional type="date" value={birthDate} max={limaDate()} onChange={(e) => setBirthDate(e.target.value)} error={show('birthDate')} />
          <SelectField label="Sexo" optional value={sex} onChange={(e) => setSex(e.target.value)}>
            <option value="">Sin indicar</option><option value="FEMALE">Femenino</option><option value="MALE">Masculino</option><option value="OTHER">Otro</option>
          </SelectField>
        </div>
        <div className="row-2">
          <TextField label="Celular" optional inputMode="numeric" value={mobile} maxLength={11} onChange={(e) => setMobile(e.target.value.replace(/[^\d\s]/g, ''))} error={show('mobile')} />
          <TextField label="Correo" optional type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} error={show('email')} />
        </div>
        {birthDate && birthDate > new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().slice(0, 10) && birthDate <= limaDate() && (
          <Alert tone="info">Es menor de edad. Después de crearlo, registre a su representante para obtener el consentimiento.</Alert>
        )}
        <p className="caption muted">Después de crearlo, el paciente podrá reservar citas. El consentimiento clínico se registra aparte.</p>
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
