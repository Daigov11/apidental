export interface PersonNames { firstName: string; lastName: string; secondLastName: string }

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Separa el nombre que informa Apiworking («NOMBRES APELLIDO-PATERNO APELLIDO-MATERNO») en los tres campos de la ficha.
 * Si Apiworking informa también los nombres solos, lo que sobra son los apellidos; si no, los dos últimos términos
 * son los apellidos. Es una sugerencia: la persona la revisa y la corrige en el formulario.
 */
export function splitPersonName(full: string, given?: string): PersonNames {
  const name = clean(full);
  const nombres = clean(given ?? '');
  if (!name) return { firstName: '', lastName: '', secondLastName: '' };
  if (nombres && name.toUpperCase().startsWith(nombres.toUpperCase()) && name.length > nombres.length) {
    const [last = '', ...rest] = clean(name.slice(nombres.length)).split(' ');
    return { firstName: nombres, lastName: last, secondLastName: rest.join(' ') };
  }
  const words = name.split(' ');
  if (words.length === 1) return { firstName: name, lastName: '', secondLastName: '' };
  if (words.length === 2) return { firstName: words[0]!, lastName: words[1]!, secondLastName: '' };
  return { firstName: words.slice(0, -2).join(' '), lastName: words.at(-2)!, secondLastName: words.at(-1)! };
}
