import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

/**
 * Especificación del odontograma ESTRUCTURADO: piezas (numeración FDI), superficies y estados. Es un formato de
 * REGISTRO de lo que el profesional observa o declara. NO genera diagnósticos, tratamientos ni presupuestos y NO
 * recomienda nada: ningún estado significa "indicado" ni "pendiente de tratar".
 *
 * FORMATO CLÍNICO POR VALIDAR: no se afirma cumplimiento de normas del MINSA mientras no exista validación formal.
 * La lista de estados es de apoyo y puede cambiar con esa validación (por eso el documento lleva `schemaVersion`).
 */
export const ODONTOGRAM_SCHEMA = 'apidental.odontogram';
export const ODONTOGRAM_SCHEMA_VERSION = 1;
export const FORMAT_NOTICE =
  'Formato clínico por validar. No se declara cumplimiento de normas del MINSA hasta su validación formal.';

export type Dentition = 'PERMANENT' | 'PRIMARY' | 'MIXED';
export const DENTITIONS: readonly Dentition[] = [
  'PERMANENT',
  'PRIMARY',
  'MIXED',
];

/** Piezas permanentes: cuadrantes 1-4, piezas 1-8. Temporales: cuadrantes 5-8, piezas 1-5. */
const range = (q: number, n: number) =>
  Array.from({ length: n }, (_, i) => `${q}${i + 1}`);
export const PERMANENT_TEETH: readonly string[] = [1, 2, 3, 4].flatMap((q) =>
  range(q, 8),
);
export const PRIMARY_TEETH: readonly string[] = [5, 6, 7, 8].flatMap((q) =>
  range(q, 5),
);

/** Orden de dibujo (izquierda a derecha del observador): la derecha del paciente queda a la izquierda. */
export const LAYOUT = {
  permanent: {
    upper: [
      '18',
      '17',
      '16',
      '15',
      '14',
      '13',
      '12',
      '11',
      '21',
      '22',
      '23',
      '24',
      '25',
      '26',
      '27',
      '28',
    ],
    lower: [
      '48',
      '47',
      '46',
      '45',
      '44',
      '43',
      '42',
      '41',
      '31',
      '32',
      '33',
      '34',
      '35',
      '36',
      '37',
      '38',
    ],
  },
  primary: {
    upper: ['55', '54', '53', '52', '51', '61', '62', '63', '64', '65'],
    lower: ['85', '84', '83', '82', '81', '71', '72', '73', '74', '75'],
  },
} as const;

export const TOOTH_STATUSES = [
  'PRESENT',
  'ABSENT',
  'UNERUPTED',
  'IMPLANT',
  'ROOT_REMNANT',
] as const;
export const SURFACES = ['M', 'D', 'O', 'V', 'L'] as const;
export const SURFACE_STATES = [
  'CARIES',
  'RESTORATION',
  'SEALANT',
  'FRACTURE',
  'OTHER',
] as const;
export const TOOTH_MARKS = ['CROWN', 'ENDODONTIC', 'PROSTHESIS'] as const;

export type ToothStatus = (typeof TOOTH_STATUSES)[number];
export type Surface = (typeof SURFACES)[number];
export type SurfaceState = (typeof SURFACE_STATES)[number];
export type ToothMark = (typeof TOOTH_MARKS)[number];

export interface ToothEntry {
  status?: Exclude<ToothStatus, 'PRESENT'>;
  surfaces?: Partial<Record<Surface, { state: SurfaceState; note?: string }>>;
  marks?: ToothMark[];
  note?: string;
}
export interface OdontogramData {
  schema: typeof ODONTOGRAM_SCHEMA;
  schemaVersion: typeof ODONTOGRAM_SCHEMA_VERSION;
  teeth: Record<string, ToothEntry>;
  notes?: string;
}

export const LIMITS = {
  toothNote: 200,
  surfaceNote: 200,
  generalNotes: 1000,
  bytes: 60_000,
} as const;

/** Textos en lenguaje de la clínica y su representación visual (para el panel, el SVG y el PDF). */
export const LEGEND = {
  toothStatus: {
    PRESENT: 'Presente',
    ABSENT: 'Ausente',
    UNERUPTED: 'Sin erupcionar',
    IMPLANT: 'Implante',
    ROOT_REMNANT: 'Resto radicular',
  },
  surface: {
    M: 'Mesial',
    D: 'Distal',
    O: 'Oclusal / incisal',
    V: 'Vestibular',
    L: 'Lingual / palatina',
  },
  surfaceState: {
    CARIES: 'Caries',
    RESTORATION: 'Restauración',
    SEALANT: 'Sellante',
    FRACTURE: 'Fractura',
    OTHER: 'Otro hallazgo',
  },
  mark: { CROWN: 'Corona', ENDODONTIC: 'Endodoncia', PROSTHESIS: 'Prótesis' },
  dentition: {
    PERMANENT: 'Dentición permanente',
    PRIMARY: 'Dentición temporal',
    MIXED: 'Dentición mixta',
  },
} as const;

/** Colores con patrón: el significado nunca depende solo del color. */
export const SURFACE_STYLE: Record<
  SurfaceState,
  { color: string; pattern: 'hatch' | 'dots' | 'cross' | 'grid' | 'solid' }
> = {
  CARIES: { color: '#b3261e', pattern: 'hatch' },
  RESTORATION: { color: '#1d4ed8', pattern: 'solid' },
  SEALANT: { color: '#157347', pattern: 'dots' },
  FRACTURE: { color: '#b45309', pattern: 'cross' },
  OTHER: { color: '#6b7280', pattern: 'grid' },
};

/** Geometría de una pieza (celda de 36×36): la superficie vestibular/lingual y la mesial/distal dependen del cuadrante. */
export const CELL = {
  size: 36,
  polygons: {
    top: [
      [0, 0],
      [36, 0],
      [24, 12],
      [12, 12],
    ],
    bottom: [
      [0, 36],
      [36, 36],
      [24, 24],
      [12, 24],
    ],
    left: [
      [0, 0],
      [12, 12],
      [12, 24],
      [0, 36],
    ],
    right: [
      [36, 0],
      [24, 12],
      [24, 24],
      [36, 36],
    ],
    center: [
      [12, 12],
      [24, 12],
      [24, 24],
      [12, 24],
    ],
  },
} as const;

export type CellSide = keyof typeof CELL.polygons;

/**
 * Dónde se dibuja cada superficie de una pieza. Arcada superior: vestibular arriba y lingual/palatina abajo; arcada
 * inferior: al revés (el lado vestibular queda hacia afuera del conjunto). Mesial = hacia la línea media.
 */
export function surfaceSide(tooth: string, surface: Surface): CellSide {
  const quadrant = Number(tooth[0]);
  const upper =
    quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6;
  const patientRight =
    quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8; // se dibuja a la izquierda
  if (surface === 'O') return 'center';
  if (surface === 'V') return upper ? 'top' : 'bottom';
  if (surface === 'L') return upper ? 'bottom' : 'top';
  const mesialSide: CellSide = patientRight ? 'right' : 'left';
  const distalSide: CellSide = patientRight ? 'left' : 'right';
  return surface === 'M' ? mesialSide : distalSide;
}

/** Especificación que consume el panel (React) para dibujar e interactuar, sin duplicar reglas. */
export function odontogramSpec() {
  return {
    schema: ODONTOGRAM_SCHEMA,
    schemaVersion: ODONTOGRAM_SCHEMA_VERSION,
    formatNotice: FORMAT_NOTICE,
    declaredByProfessional: true,
    notice:
      'Registra lo que el profesional observa o declara. No genera tratamientos, presupuestos ni diagnósticos, ni recomienda nada.',
    numbering: 'FDI',
    dentitions: DENTITIONS.map((d) => ({
      code: d,
      label: LEGEND.dentition[d],
    })),
    layout: LAYOUT,
    teeth: { permanent: PERMANENT_TEETH, primary: PRIMARY_TEETH },
    cell: CELL,
    surfaceRules: {
      O: 'Centro de la pieza.',
      V: 'Arcada superior: arriba · arcada inferior: abajo (hacia afuera).',
      L: 'Arcada superior: abajo · arcada inferior: arriba.',
      M: 'Hacia la línea media.',
      D: 'Hacia el fondo de la boca.',
    },
    toothStatuses: TOOTH_STATUSES.map((c) => ({
      code: c,
      label: LEGEND.toothStatus[c],
      default: c === 'PRESENT',
    })),
    surfaces: SURFACES.map((c) => ({ code: c, label: LEGEND.surface[c] })),
    surfaceStates: SURFACE_STATES.map((c) => ({
      code: c,
      label: LEGEND.surfaceState[c],
      ...SURFACE_STYLE[c],
    })),
    marks: TOOTH_MARKS.map((c) => ({ code: c, label: LEGEND.mark[c] })),
    limits: LIMITS,
    example: {
      schema: ODONTOGRAM_SCHEMA,
      schemaVersion: ODONTOGRAM_SCHEMA_VERSION,
      teeth: {
        '16': { surfaces: { O: { state: 'CARIES' } } },
        '36': { status: 'ABSENT' },
        '46': { marks: ['CROWN'] },
      },
      notes: 'Ejemplo de estructura (dato ficticio).',
    },
  };
}

const bad = (message: string): never => {
  // Los mensajes NUNCA repiten lo enviado.
  throw new BadRequestException({
    message: `Odontograma inválido: ${message}`,
    code: 'INVALID_ODONTOGRAM',
  });
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (
  o: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
) => {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    bad(`${what} contiene campos desconocidos`);
};
const cleanText = (
  v: unknown,
  max: number,
  what: string,
): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return bad(`${what} debe ser texto`);
  const t = v.trim();
  if (t.length > max) return bad(`${what} supera los ${max} caracteres`);
  return t === '' ? undefined : t;
};

export function allowedTeeth(dentition: Dentition): readonly string[] {
  return dentition === 'PERMANENT'
    ? PERMANENT_TEETH
    : dentition === 'PRIMARY'
      ? PRIMARY_TEETH
      : [...PERMANENT_TEETH, ...PRIMARY_TEETH];
}

/**
 * Valida y NORMALIZA la estructura (claves ordenadas, sin valores por defecto, texto recortado) para que dos
 * odontogramas iguales tengan el mismo contenido y la misma huella. Rechaza campos desconocidos, piezas fuera de la
 * dentición, estados inexistentes y combinaciones incoherentes (p. ej. superficies en una pieza ausente).
 */
export function normalizeOdontogram(
  input: unknown,
  dentition: Dentition,
): OdontogramData {
  if (!isObj(input)) return bad('la estructura debe ser un objeto');
  onlyKeys(
    input,
    ['schema', 'schemaVersion', 'teeth', 'notes'],
    'el odontograma',
  );
  if (
    input['schema'] !== ODONTOGRAM_SCHEMA ||
    input['schemaVersion'] !== ODONTOGRAM_SCHEMA_VERSION
  )
    bad('esquema o versión de esquema no soportados');
  const rawTeeth = input['teeth'] ?? {};
  if (!isObj(rawTeeth)) return bad('"teeth" debe ser un objeto');
  const allowed = allowedTeeth(dentition);
  const teeth: Record<string, ToothEntry> = {};
  for (const code of Object.keys(rawTeeth).sort(
    (a, b) => Number(a) - Number(b),
  )) {
    if (!allowed.includes(code))
      bad('hay una pieza que no corresponde a la dentición indicada');
    const t = rawTeeth[code];
    if (!isObj(t)) return bad('cada pieza debe ser un objeto');
    onlyKeys(t, ['status', 'surfaces', 'marks', 'note'], 'una pieza');
    const entry: ToothEntry = {};
    const status = t['status'] ?? 'PRESENT';
    if (
      typeof status !== 'string' ||
      !(TOOTH_STATUSES as readonly string[]).includes(status)
    )
      bad('estado de pieza desconocido');
    if (status !== 'PRESENT')
      entry.status = status as Exclude<ToothStatus, 'PRESENT'>;
    const rawSurfaces = t['surfaces'] ?? {};
    if (!isObj(rawSurfaces)) return bad('"surfaces" debe ser un objeto');
    const surfaces: NonNullable<ToothEntry['surfaces']> = {};
    for (const s of SURFACES) {
      if (!(s in rawSurfaces)) continue;
      const v = rawSurfaces[s];
      if (!isObj(v)) return bad('cada superficie debe ser un objeto');
      onlyKeys(v, ['state', 'note'], 'una superficie');
      if (
        typeof v['state'] !== 'string' ||
        !(SURFACE_STATES as readonly string[]).includes(v['state'])
      )
        bad('estado de superficie desconocido');
      const note = cleanText(
        v['note'],
        LIMITS.surfaceNote,
        'la nota de una superficie',
      );
      surfaces[s] = {
        state: v['state'] as SurfaceState,
        ...(note ? { note } : {}),
      };
    }
    if (
      Object.keys(rawSurfaces).some(
        (k) => !(SURFACES as readonly string[]).includes(k),
      )
    )
      bad('hay una superficie desconocida');
    const rawMarks = t['marks'] ?? [];
    if (!Array.isArray(rawMarks)) return bad('"marks" debe ser una lista');
    if (
      rawMarks.some(
        (m) =>
          typeof m !== 'string' ||
          !(TOOTH_MARKS as readonly string[]).includes(m),
      )
    )
      bad('marca de pieza desconocida');
    const marks = TOOTH_MARKS.filter((m) => rawMarks.includes(m));
    if (marks.length !== rawMarks.length)
      bad('hay una marca repetida o desconocida');
    const note = cleanText(t['note'], LIMITS.toothNote, 'la nota de una pieza');
    const absent = entry.status === 'ABSENT' || entry.status === 'UNERUPTED';
    if (absent && (Object.keys(surfaces).length > 0 || marks.length > 0))
      bad('una pieza ausente o sin erupcionar no admite superficies ni marcas');
    if (Object.keys(surfaces).length > 0) entry.surfaces = surfaces;
    if (marks.length > 0) entry.marks = marks;
    if (note) entry.note = note;
    if (Object.keys(entry).length > 0) teeth[code] = entry;
  }
  const notes = cleanText(
    input['notes'],
    LIMITS.generalNotes,
    'las notas generales',
  );
  const out: OdontogramData = {
    schema: ODONTOGRAM_SCHEMA,
    schemaVersion: ODONTOGRAM_SCHEMA_VERSION,
    teeth,
    ...(notes ? { notes } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > LIMITS.bytes)
    bad('el contenido es demasiado grande');
  return out;
}

export const emptyOdontogram = (): OdontogramData => ({
  schema: ODONTOGRAM_SCHEMA,
  schemaVersion: ODONTOGRAM_SCHEMA_VERSION,
  teeth: {},
});

/** Huella de integridad de una versión guardada (evidencia técnica; NO es una firma). */
export const odontogramHash = (r: {
  patientId: string;
  version: number;
  dentition: string;
  data: unknown;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        p: r.patientId,
        v: r.version,
        d: r.dentition,
        c: r.data,
      }),
    )
    .digest('hex');

/** Descripción en texto de lo registrado en cada pieza (para el PDF y para quien no puede ver colores). */
export function describeFindings(
  data: OdontogramData,
): { tooth: string; text: string }[] {
  return Object.entries(data.teeth).map(([tooth, e]) => {
    const parts: string[] = [];
    parts.push(LEGEND.toothStatus[e.status ?? 'PRESENT']);
    for (const s of SURFACES) {
      const v = e.surfaces?.[s];
      if (v)
        parts.push(
          `${LEGEND.surface[s]}: ${LEGEND.surfaceState[v.state]}${v.note ? ` (${v.note})` : ''}`,
        );
    }
    for (const m of e.marks ?? []) parts.push(LEGEND.mark[m]);
    if (e.note) parts.push(`Nota: ${e.note}`);
    return { tooth, text: parts.join(' · ') };
  });
}
