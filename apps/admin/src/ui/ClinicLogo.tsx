import { useState } from 'react';

/**
 * Logo propio de la clínica, junto al de APIMedical. El panel es el mismo para todos los clientes: si la instancia publica
 * su logo en `<base>marca/logo.png` (lo sirve su nginx) se muestra; si no existe, no aparece nada.
 */
export function ClinicLogo({ className }: { className: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return <img className={className} src={`${import.meta.env.BASE_URL}marca/logo.png`} alt="Logo de la clínica" onError={() => setOk(false)} />;
}
