import { Film } from 'lucide-react';
import { EmptyState } from '../ui/feedback';

export function FotogramaPage() {
  return (
    <>
      <div className="page-head"><h1>Fotograma</h1></div>
      <EmptyState icon={<Film size={40} aria-hidden="true" />} title="Próximamente">
        Este apartado estará disponible en una próxima versión.
      </EmptyState>
    </>
  );
}
