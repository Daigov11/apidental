import { FlaskConical } from 'lucide-react';
import { useIntegrations } from '../lib/integrations';

/** Aviso fijo: toda cifra de cobros, comprobantes, fidelización y reseñas proviene de una simulación. */
export function SimulationBanner() {
  const { simulation } = useIntegrations();
  if (!simulation) return null;
  return (
    <div className="sim-banner" role="note">
      <FlaskConical size={18} aria-hidden="true" />
      <span><strong>{simulation.demoMark}.</strong> {simulation.label}</span>
    </div>
  );
}
