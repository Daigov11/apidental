import { useMemo, type KeyboardEvent } from 'react';
import type { Dentition, OdontogramSpecLite, ToothEntry } from '../../api/types';
import { TOOTH_TEMPLATES, type ToothTemplate } from './teeth-data';

/** Qué superficie ocupa cada lado de la celda oclusal (docs/diseno/odontograma.md §3). Se conserva para el selector en cruz. */
export type Side = 'top' | 'bottom' | 'left' | 'right' | 'center';
export function surfaceSide(tooth: string, surface: string): Side {
  const q = Number(tooth[0]);
  const upper = q === 1 || q === 2 || q === 5 || q === 6;
  const patientRight = q === 1 || q === 4 || q === 5 || q === 8;
  if (surface === 'O') return 'center';
  if (surface === 'V') return upper ? 'top' : 'bottom';
  if (surface === 'L') return upper ? 'bottom' : 'top';
  const mesial: Side = patientRight ? 'right' : 'left';
  const distal: Side = patientRight ? 'left' : 'right';
  return surface === 'M' ? mesial : distal;
}

const CARD_W = 54;
const SIDE_H = 108;
const OCCL_H = 54;
const GAP = 4;
const MIDLINE_GAP = 16;
const LABEL_H = 16;
const PAD = 3;
const BLOCK_GAP = 22;

/** Plantilla anatómica de una pieza: los cuadrantes 1/2, 3/4, 5/6 y 7/8 comparten dibujo (el segundo se refleja). */
const templateOf = (code: string) => `${{ 1: 1, 2: 1, 3: 3, 4: 3, 5: 5, 6: 5, 7: 7, 8: 7 }[Number(code[0])]}${code[1]}`;
const isMirrored = (code: string) => [2, 4, 6, 8].includes(Number(code[0]));
const isUpperArch = (code: string) => [1, 2, 5, 6].includes(Number(code[0]));

export const toothSummary = (code: string, t: ToothEntry | undefined, spec: OdontogramSpecLite): string => {
  const lab = (list: { code: string; label: string }[], c: string) => list.find((x) => x.code === c)?.label ?? c;
  const parts = [t?.status && t.status !== 'PRESENT' ? lab(spec.toothStatuses, t.status) : 'presente'];
  for (const [s, v] of Object.entries(t?.surfaces ?? {})) parts.push(`${lab(spec.surfaces, s).toLowerCase()} ${lab(spec.surfaceStates, v.state).toLowerCase()}`);
  for (const m of t?.marks ?? []) parts.push(lab(spec.marks, m).toLowerCase());
  return `Pieza ${code}: ${parts.join(', ')}`;
};

type View = 'side' | 'occl';
const LAYER_OF_SURFACE: Record<string, string> = { M: 'mesial', D: 'distal', O: 'occlusal', V: 'buccal', L: 'lingual' };
const BROKEN: Record<string, string> = {
  incisal: 'broken-incisal', 'mesial-incisal': 'broken-mesial-incisal', 'distal-incisal': 'broken-distal-incisal', 'mesial-distal': 'broken-mesial-distal',
  'mesial-distal-incisal': 'broken-mesial-distal-incisal', mesial: 'broken-mesial', distal: 'broken-distal',
};

/** Capas de la plantilla que se dibujan para esta pieza, según su registro. El orden de dibujo lo da la plantilla. */
export function activeLayers(t: ToothEntry | undefined, view: View): Set<string> {
  const on = new Set<string>(['base']);
  const status = t?.status ?? 'PRESENT';
  const surfaces = t?.surfaces ?? {};
  const marks = t?.marks ?? [];
  const natural = status === 'PRESENT' || status === 'UNERUPTED';
  if (view === 'side') {
    if (status === 'ABSENT') on.add('absent');
    else if (status === 'UNERUPTED') on.add('unerupted');
    else if (status === 'ROOT_REMNANT') on.add('radix');
    else if (status === 'IMPLANT') on.add('implant');
    else {
      const f = (['M', 'D', 'O'] as const).filter((s) => surfaces[s]?.state === 'FRACTURE');
      const key = [f.includes('M') && 'mesial', f.includes('D') && 'distal', f.includes('O') && 'incisal'].filter(Boolean).join('-');
      on.add(BROKEN[key] ?? 'tooth');
      if (marks.includes('ENDODONTIC')) on.add('endo'); else on.add('pulp');
    }
  } else if (status === 'IMPLANT') on.add('implant');
  else if (natural) on.add('tooth');
  if (natural) {
    for (const [s, v] of Object.entries(surfaces)) {
      const n = LAYER_OF_SURFACE[s];
      if (!n) continue;
      if (v.state === 'CARIES') on.add(`caries-${n}`);
      else if (v.state === 'RESTORATION') on.add(`fill-${n}`);
      else if (v.state === 'SEALANT') on.add('sealant');
      else if (v.state === 'FRACTURE' && view === 'side' && (s === 'V' || s === 'L')) on.add('fracture');
    }
  }
  if (status !== 'ABSENT') {
    if (marks.includes('CROWN')) on.add('crown');
    if (view === 'side' && marks.includes('PROSTHESIS')) on.add('prosthesis');
  }
  return on;
}

const layersXml = (tpl: ToothTemplate, on: Set<string>) =>
  Object.entries(tpl.layers).filter(([k]) => on.has(k)).map(([, xml]) => xml).join('');

function layout(spec: OdontogramSpecLite, dentition: Dentition) {
  const L = spec.layout!;
  const list = dentition === 'PERMANENT' ? [L.permanent] : dentition === 'PRIMARY' ? [L.primary] : [L.permanent, L.primary];
  const unit = CARD_W + GAP;
  const rowWidth = (n: number) => n * unit - GAP + MIDLINE_GAP;
  const width = Math.max(...list.map((b) => rowWidth(b.upper.length)));
  const blockH = LABEL_H + SIDE_H + GAP + OCCL_H + GAP + OCCL_H + GAP + SIDE_H + LABEL_H;
  return { blocks: list.map((teeth, i) => ({ teeth, y: i * (blockH + BLOCK_GAP) })), width, height: list.length * blockH + (list.length - 1) * BLOCK_GAP, rowWidth, unit };
}

interface Props {
  spec: OdontogramSpecLite;
  dentition: Dentition;
  teeth: Record<string, ToothEntry>;
  selected: string | null;
  /** Si se pasa, el dibujo es interactivo (clic o Enter eligen la pieza). */
  onSelect?: (tooth: string) => void;
  /** Ampliación máxima: el dibujo se ajusta al ancho disponible sin pasar de `ancho natural × zoom`. */
  zoom?: number;
}

/**
 * Carta dental (numeración FDI) con el aspecto de React Advanced Odontogram: cada pieza es una tarjeta con hueso, encía,
 * pulpa y raíces (vista lateral) y, en premolares y molares, su vista oclusal. Los hallazgos se pintan sobre el diente
 * activando las capas de la plantilla; el dibujo no calcula ni sugiere nada.
 */
export function OdontogramFigure({ spec, dentition, teeth, selected, onSelect, zoom = 1.8 }: Props) {
  const { blocks, width, height, rowWidth, unit } = useMemo(() => layout(spec, dentition), [spec, dentition]);
  const interactive = Boolean(onSelect);

  const usedTemplates = useMemo(() => {
    const set = new Set<string>();
    for (const b of blocks) for (const code of [...b.teeth.upper, ...b.teeth.lower]) { set.add(templateOf(code)); set.add(`${templateOf(code)}_occl`); }
    return [...set].filter((k) => TOOTH_TEMPLATES[k]);
  }, [blocks]);

  const onKey = (e: KeyboardEvent<SVGGElement>, row: readonly string[], idx: number) => {
    const code = row[idx]!;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(code); return; }
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = row[idx + delta];
    if (next) (e.currentTarget.ownerSVGElement?.querySelector(`[data-tooth="${next}"][data-view="side"]`) as SVGGElement | null)?.focus();
  };

  const card = (code: string, view: View, x: number, y: number, row: readonly string[], idx: number) => {
    const tpl = TOOTH_TEMPLATES[view === 'side' ? templateOf(code) : `${templateOf(code)}_occl`];
    const h = view === 'side' ? SIDE_H : OCCL_H;
    const t = teeth[code];
    const isSel = selected === code;
    const vb = tpl?.viewBox.split(' ').map(Number) ?? [0, 0, 1, 1];
    const mirror = isMirrored(code) ? `translate(${2 * vb[0]! + vb[2]!},0) scale(-1,1)` : '';
    const flip = view === 'side' && !isUpperArch(code) ? `translate(0,${2 * vb[1]! + vb[3]!}) scale(1,-1)` : '';
    const inner = tpl ? layersXml(tpl, activeLayers(t, view)) : '';
    const other = view === 'side' && Object.values(t?.surfaces ?? {}).some((s) => s.state === 'OTHER');
    const focusable = interactive && view === 'side';
    return (
      <g
        key={`${code}-${view}`}
        data-tooth={code}
        data-view={view}
        transform={`translate(${x},${y})`}
        className={`odonto-card${isSel ? ' is-selected' : ''}${interactive && tpl ? ' is-interactive' : ''}${tpl ? '' : ' is-empty'}`}
        {...(focusable ? { role: 'button', tabIndex: 0, 'aria-pressed': isSel, 'aria-label': toothSummary(code, t, spec), onKeyDown: (e: KeyboardEvent<SVGGElement>) => onKey(e, row, idx) } : { 'aria-hidden': true })}
        {...(interactive && tpl ? { onClick: () => onSelect?.(code) } : {})}
      >
        <rect width={CARD_W} height={h} rx={6} className="odonto-card-bg" />
        {tpl && (
          <svg x={PAD} y={PAD} width={CARD_W - 2 * PAD} height={h - 2 * PAD} viewBox={tpl.viewBox} preserveAspectRatio="xMidYMid meet" className="odonto-pic">
            <g transform={`${mirror} ${flip}`.trim() || undefined} dangerouslySetInnerHTML={{ __html: inner }} />
          </svg>
        )}
        {other && <circle cx={CARD_W - 7} cy={7} r={4} className="odonto-other"><title>Otro hallazgo</title></circle>}
      </g>
    );
  };

  return (
    <svg className="odonto-svg" viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: width * zoom, height: 'auto' }} role="group" aria-label="Odontograma, numeración FDI">
      <defs>
        {usedTemplates.map((k) => <g key={k} dangerouslySetInnerHTML={{ __html: TOOTH_TEMPLATES[k]!.defs }} />)}
      </defs>
      {blocks.map((b, bi) => {
        const n = b.teeth.upper.length;
        const x0 = (width - rowWidth(n)) / 2;
        const xOf = (i: number) => x0 + i * unit + (i >= n / 2 ? MIDLINE_GAP : 0);
        const ySideU = b.y + LABEL_H;
        const yOccU = ySideU + SIDE_H + GAP;
        const yOccL = yOccU + OCCL_H + GAP;
        const ySideL = yOccL + OCCL_H + GAP;
        const midX = x0 + (n / 2) * unit - GAP + MIDLINE_GAP / 2;
        const num = (c: string, i: number, y: number) => (
          <text key={`n${c}`} x={xOf(i) + CARD_W / 2} y={y} textAnchor="middle" className={`odonto-num${selected === c ? ' is-selected' : ''}`}>{c}</text>
        );
        return (
          <g key={bi}>
            {b.teeth.upper.map((c, i) => num(c, i, b.y + 11))}
            {b.teeth.upper.map((c, i) => card(c, 'side', xOf(i), ySideU, b.teeth.upper, i))}
            {b.teeth.upper.map((c, i) => card(c, 'occl', xOf(i), yOccU, b.teeth.upper, i))}
            {b.teeth.lower.map((c, i) => card(c, 'occl', xOf(i), yOccL, b.teeth.lower, i))}
            {b.teeth.lower.map((c, i) => card(c, 'side', xOf(i), ySideL, b.teeth.lower, i))}
            {b.teeth.lower.map((c, i) => num(c, i, ySideL + SIDE_H + 12))}
            <line x1={midX} x2={midX} y1={b.y} y2={ySideL + SIDE_H + LABEL_H} className="odonto-midline" />
          </g>
        );
      })}
    </svg>
  );
}
