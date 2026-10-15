import {
  CELL,
  type CellSide,
  type Dentition,
  LAYOUT,
  LEGEND,
  type OdontogramData,
  SURFACE_STATES,
  SURFACE_STYLE,
  SURFACES,
  surfaceSide,
  type ToothEntry,
} from './odontogram-spec.js';

const PITCH = 40; // 36 de celda + 4 de separación
const MIDLINE_GAP = 18;
const MARGIN = 24;
const ROW_LABEL_H = 14;
const ROW_GAP = 22;
const xml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );

export interface RowSpec {
  key: string;
  label: string;
  teeth: readonly string[];
  position: 'upper' | 'lower';
}

/** Filas a dibujar según la dentición: permanente, temporal o mixta (cuatro filas). */
export function rowsFor(dentition: Dentition): RowSpec[] {
  const P = LAYOUT.permanent;
  const T = LAYOUT.primary;
  if (dentition === 'PERMANENT')
    return [
      { key: 'pu', label: 'Superior', teeth: P.upper, position: 'upper' },
      { key: 'pl', label: 'Inferior', teeth: P.lower, position: 'lower' },
    ];
  if (dentition === 'PRIMARY')
    return [
      { key: 'tu', label: 'Superior', teeth: T.upper, position: 'upper' },
      { key: 'tl', label: 'Inferior', teeth: T.lower, position: 'lower' },
    ];
  return [
    {
      key: 'pu',
      label: 'Superior permanente',
      teeth: P.upper,
      position: 'upper',
    },
    {
      key: 'tu',
      label: 'Superior temporal',
      teeth: T.upper,
      position: 'upper',
    },
    {
      key: 'tl',
      label: 'Inferior temporal',
      teeth: T.lower,
      position: 'lower',
    },
    {
      key: 'pl',
      label: 'Inferior permanente',
      teeth: P.lower,
      position: 'lower',
    },
  ];
}

/** Posición X de la pieza `index` dentro de una fila de `count` piezas (con espacio en la línea media). */
export const toothX = (index: number, count: number, offset = 0): number =>
  offset + MARGIN + index * PITCH + (index >= count / 2 ? MIDLINE_GAP : 0);

const pts = (
  poly: readonly (readonly number[])[],
  dx: number,
  dy: number,
): string => poly.map(([x, y]) => `${x! + dx},${y! + dy}`).join(' ');

function patternDefs(): string {
  const d: string[] = [];
  for (const state of SURFACE_STATES) {
    const { color, pattern } = SURFACE_STYLE[state];
    const id = `p-${state}`;
    if (pattern === 'hatch')
      d.push(
        `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#fff"/><line x1="0" y1="0" x2="0" y2="5" stroke="${color}" stroke-width="2.4"/></pattern>`,
      );
    else if (pattern === 'dots')
      d.push(
        `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#fff"/><circle cx="3" cy="3" r="1.6" fill="${color}"/></pattern>`,
      );
    else if (pattern === 'cross')
      d.push(
        `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#fff"/><path d="M0 0L6 6M6 0L0 6" stroke="${color}" stroke-width="1.2"/></pattern>`,
      );
    else if (pattern === 'grid')
      d.push(
        `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#fff"/><path d="M0 3H6M3 0V6" stroke="${color}" stroke-width="1"/></pattern>`,
      );
  }
  return `<defs>${d.join('')}</defs>`;
}

const fillOf = (state: keyof typeof SURFACE_STYLE): string =>
  SURFACE_STYLE[state].pattern === 'solid'
    ? SURFACE_STYLE[state].color
    : `url(#p-${state})`;

function describeTooth(code: string, e: ToothEntry | undefined): string {
  if (!e) return `Pieza ${code}: presente, sin hallazgos registrados`;
  const parts: string[] = [LEGEND.toothStatus[e.status ?? 'PRESENT']];
  for (const s of SURFACES)
    if (e.surfaces?.[s])
      parts.push(
        `${LEGEND.surface[s]} ${LEGEND.surfaceState[e.surfaces[s]!.state]}`,
      );
  for (const m of e.marks ?? []) parts.push(LEGEND.mark[m]);
  return `Pieza ${code}: ${parts.join(', ')}`;
}

function tooth(
  code: string,
  e: ToothEntry | undefined,
  x: number,
  y: number,
  position: 'upper' | 'lower',
): string {
  const out: string[] = [
    `<g id="tooth-${code}" role="img" aria-label="${xml(describeTooth(code, e))}"><title>${xml(describeTooth(code, e))}</title>`,
  ];
  const dashed = e?.status === 'UNERUPTED' ? ' stroke-dasharray="3 2"' : '';
  // superficies
  const bySide = new Map<CellSide, string>();
  for (const s of SURFACES) {
    const v = e?.surfaces?.[s];
    if (v) bySide.set(surfaceSide(code, s), fillOf(v.state));
  }
  for (const side of [
    'top',
    'bottom',
    'left',
    'right',
    'center',
  ] as CellSide[]) {
    out.push(
      `<polygon points="${pts(CELL.polygons[side], x, y)}" fill="${bySide.get(side) ?? '#ffffff'}" stroke="#374151" stroke-width="1"${dashed}/>`,
    );
  }
  const cx = x + CELL.size / 2;
  const cy = y + CELL.size / 2;
  if (e?.status === 'ABSENT')
    out.push(
      `<path d="M${x + 3} ${y + 3}L${x + 33} ${y + 33}M${x + 33} ${y + 3}L${x + 3} ${y + 33}" stroke="#111827" stroke-width="2.4" stroke-linecap="round"/>`,
    );
  if (e?.status === 'IMPLANT')
    out.push(
      `<circle cx="${cx}" cy="${cy}" r="9" fill="#fff" stroke="#111827" stroke-width="1.6"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#111827">I</text>`,
    );
  if (e?.status === 'ROOT_REMNANT')
    out.push(
      `<circle cx="${cx}" cy="${cy}" r="9" fill="#fff" stroke="#111827" stroke-width="1.6"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#111827">R</text>`,
    );
  for (const m of e?.marks ?? []) {
    if (m === 'CROWN')
      out.push(
        `<circle cx="${cx}" cy="${cy}" r="19.5" fill="none" stroke="#111827" stroke-width="1.8"/>`,
      );
    if (m === 'ENDODONTIC')
      out.push(
        `<path d="M${cx} ${y + 2}V${y + 34}" stroke="#111827" stroke-width="2.4"/>`,
      );
    if (m === 'PROSTHESIS')
      out.push(
        `<path d="M${x} ${position === 'upper' ? y - 3 : y + 39}H${x + 36}" stroke="#111827" stroke-width="3"/>`,
      );
  }
  out.push('</g>');
  return out.join('');
}

export interface SvgOptions {
  title?: string;
  /** Fecha y versión u otro texto corto para el pie. */
  caption?: string;
  /** Muestra la leyenda de estados al pie. */
  legend?: boolean;
}

/**
 * Dibuja el odontograma como SVG autónomo (el panel puede incrustarlo tal cual o reproducir la misma geometría).
 * Cada pieza es un grupo con `id="tooth-<FDI>"`, `role="img"` y una descripción en texto.
 */
export function renderOdontogramSvg(
  data: OdontogramData,
  dentition: Dentition,
  opts: SvgOptions = {},
): string {
  const rows = rowsFor(dentition);
  const count = rows[0]!.teeth.length;
  const width = MARGIN * 2 + count * PITCH + MIDLINE_GAP;
  const rowH = ROW_LABEL_H + 16 + CELL.size + 16;
  const legendH = opts.legend === false ? 0 : 92;
  const titleH = opts.title ? 26 : 0;
  const height =
    titleH +
    MARGIN +
    rows.length * (rowH + ROW_GAP) +
    legendH +
    (opts.caption ? 22 : 0);
  const body: string[] = [];
  if (opts.title)
    body.push(
      `<text x="${MARGIN}" y="20" font-size="15" font-weight="700" fill="#111827">${xml(opts.title)}</text>`,
    );
  rows.forEach((r, i) => {
    const top = titleH + MARGIN + i * (rowH + ROW_GAP);
    body.push(
      `<text x="${MARGIN}" y="${top + 10}" font-size="11" fill="#374151">${xml(r.label)}</text>`,
    );
    const cellY = top + ROW_LABEL_H + 16;
    r.teeth.forEach((code, k) => {
      const x = toothX(k, r.teeth.length);
      const numY = r.position === 'upper' ? cellY - 6 : cellY + CELL.size + 13;
      body.push(
        `<text x="${x + CELL.size / 2}" y="${numY}" text-anchor="middle" font-size="11" fill="#111827">${code}</text>`,
      );
      body.push(tooth(code, data.teeth[code], x, cellY, r.position));
    });
    body.push(
      `<line x1="${toothX(r.teeth.length / 2, r.teeth.length) - MIDLINE_GAP / 2 - 2}" y1="${cellY - 8}" x2="${toothX(r.teeth.length / 2, r.teeth.length) - MIDLINE_GAP / 2 - 2}" y2="${cellY + CELL.size + 8}" stroke="#9ca3af" stroke-dasharray="2 3"/>`,
    );
  });
  if (opts.legend !== false) {
    const ly = titleH + MARGIN + rows.length * (rowH + ROW_GAP) + 4;
    SURFACE_STATES.forEach((s, i) => {
      const lx = MARGIN + i * 118;
      body.push(
        `<rect x="${lx}" y="${ly}" width="16" height="16" fill="${fillOf(s)}" stroke="#374151"/><text x="${lx + 22}" y="${ly + 12}" font-size="11" fill="#111827">${xml(LEGEND.surfaceState[s])}</text>`,
      );
    });
    [
      'Pieza ausente: aspa · Implante: I · Resto radicular: R · Corona: círculo',
      'Endodoncia: línea vertical · Prótesis: barra · Sin erupcionar: borde punteado',
      'Numeración FDI. Vestibular y lingual/palatina arriba o abajo según la arcada; mesial hacia la línea media.',
    ].forEach((t, i) =>
      body.push(
        `<text x="${MARGIN}" y="${ly + 38 + i * 16}" font-size="11" fill="#374151">${xml(t)}</text>`,
      ),
    );
  }
  if (opts.caption)
    body.push(
      `<text x="${MARGIN}" y="${height - 8}" font-size="11" fill="#374151">${xml(opts.caption)}</text>`,
    );
  const label = `${opts.title ?? 'Odontograma'}: ${Object.keys(data.teeth).length} pieza(s) con hallazgos registrados`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${xml(label)}" font-family="Helvetica, Arial, sans-serif"><title>${xml(label)}</title><desc>Odontograma estructurado (numeración FDI). Formato clínico por validar.</desc>${patternDefs()}<rect width="${width}" height="${height}" fill="#ffffff"/>${body.join('')}</svg>`;
}
