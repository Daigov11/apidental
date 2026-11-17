import PDFDocument from 'pdfkit';
import {
  CELL,
  type CellSide,
  describeFindings,
  diffOdontogram,
  type Dentition,
  FORMAT_NOTICE,
  LEGEND,
  type OdontogramData,
  SURFACE_STATES,
  SURFACE_STYLE,
  SURFACES,
  surfaceSide,
  type ToothEntry,
} from './odontogram-spec.js';
import { rowsFor, toothX } from './odontogram-svg.js';

export interface OdontogramPdfInput {
  clinicName: string;
  patient: {
    fullName: string;
    document: string | null;
    birthDate: string | null;
    age: number | null;
  };
  version: {
    number: number;
    stateLabel: string;
    kindLabel: string;
    savedAt: Date;
    author: string;
    hash: string | null;
    reason: string | null;
  };
  dentition: Dentition;
  data: OdontogramData;
  generatedAt: Date;
  generatedBy: string;
}

const MARGIN_X = 50;
const fmt = (d: Date) =>
  new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(d);

type Doc = InstanceType<typeof PDFDocument>;

function drawSurface(
  doc: Doc,
  side: CellSide,
  ox: number,
  oy: number,
  state: keyof typeof SURFACE_STYLE | null,
): void {
  const poly = CELL.polygons[side].map(
    ([x, y]) => [ox + x!, oy + y!] as [number, number],
  );
  doc.save();
  doc.polygon(...poly).clip();
  if (!state) {
    doc.rect(ox, oy, CELL.size, CELL.size).fill('#ffffff');
  } else {
    const { color, pattern } = SURFACE_STYLE[state];
    if (pattern === 'solid') doc.rect(ox, oy, CELL.size, CELL.size).fill(color);
    else {
      doc.rect(ox, oy, CELL.size, CELL.size).fill('#ffffff');
      doc.lineWidth(1.2).strokeColor(color);
      if (pattern === 'hatch')
        for (let k = -36; k < 72; k += 5)
          doc
            .moveTo(ox + k, oy)
            .lineTo(ox + k + 36, oy + 36)
            .stroke();
      if (pattern === 'cross') {
        for (let k = -36; k < 72; k += 6)
          doc
            .moveTo(ox + k, oy)
            .lineTo(ox + k + 36, oy + 36)
            .stroke();
        for (let k = -36; k < 72; k += 6)
          doc
            .moveTo(ox + k + 36, oy)
            .lineTo(ox + k, oy + 36)
            .stroke();
      }
      if (pattern === 'grid')
        for (let k = 0; k <= 36; k += 6)
          doc
            .moveTo(ox + k, oy)
            .lineTo(ox + k, oy + 36)
            .moveTo(ox, oy + k)
            .lineTo(ox + 36, oy + k)
            .stroke();
      if (pattern === 'dots')
        for (let a = 3; a < 36; a += 6)
          for (let b = 3; b < 36; b += 6)
            doc.circle(ox + a, oy + b, 1.3).fill(color);
    }
  }
  doc.restore();
  doc
    .polygon(...poly)
    .lineWidth(0.9)
    .strokeColor('#374151')
    .stroke();
}

function drawTooth(
  doc: Doc,
  code: string,
  e: ToothEntry | undefined,
  x: number,
  y: number,
  position: 'upper' | 'lower',
): void {
  const bySide = new Map<CellSide, keyof typeof SURFACE_STYLE>();
  for (const s of SURFACES)
    if (e?.surfaces?.[s])
      bySide.set(surfaceSide(code, s), e.surfaces[s]!.state);
  for (const side of ['top', 'bottom', 'left', 'right', 'center'] as CellSide[])
    drawSurface(doc, side, x, y, bySide.get(side) ?? null);
  const cx = x + 18;
  const cy = y + 18;
  doc.strokeColor('#111827').fillColor('#111827');
  if (e?.status === 'ABSENT')
    doc
      .lineWidth(2.4)
      .moveTo(x + 3, y + 3)
      .lineTo(x + 33, y + 33)
      .moveTo(x + 33, y + 3)
      .lineTo(x + 3, y + 33)
      .stroke();
  if (e?.status === 'UNERUPTED')
    doc.lineWidth(1).dash(3, { space: 2 }).rect(x, y, 36, 36).stroke().undash();
  if (e?.status === 'IMPLANT' || e?.status === 'ROOT_REMNANT') {
    doc.circle(cx, cy, 9).lineWidth(1.5).fillAndStroke('#ffffff', '#111827');
    doc
      .fillColor('#111827')
      .fontSize(10)
      .font('Helvetica-Bold')
      .text(e.status === 'IMPLANT' ? 'I' : 'R', cx - 5, cy - 5, {
        width: 10,
        align: 'center',
        lineBreak: false,
      });
  }
  for (const m of e?.marks ?? []) {
    if (m === 'CROWN') doc.circle(cx, cy, 19.5).lineWidth(1.6).stroke();
    if (m === 'ENDODONTIC')
      doc
        .lineWidth(2.4)
        .moveTo(cx, y + 2)
        .lineTo(cx, y + 34)
        .stroke();
    if (m === 'PROSTHESIS')
      doc
        .lineWidth(3)
        .moveTo(x, position === 'upper' ? y - 3 : y + 39)
        .lineTo(x + 36, position === 'upper' ? y - 3 : y + 39)
        .stroke();
  }
  doc.fillColor('#000000').strokeColor('#000000');
}

function drawChart(
  doc: Doc,
  dentition: Dentition,
  data: OdontogramData,
  W: number,
): void {
  const rows = rowsFor(dentition);
  const count = rows[0]!.teeth.length;
  const svgWidth = 24 * 2 + count * 40 + 18;
  const k = Math.min(1, W / svgWidth);
  const rowH = 14 + 16 + 36 + 16 + 14;
  let top = doc.y;
  if (top + rows.length * rowH * k + 20 > doc.page.height - 120) {
    doc.addPage();
    top = doc.y;
  }
  doc.save();
  doc.translate(MARGIN_X, top).scale(k);
  rows.forEach((r, i) => {
    const oy = i * rowH;
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#374151')
      .text(r.label, 0, oy, { lineBreak: false });
    const cellY = oy + 28;
    r.teeth.forEach((code, idx) => {
      const x = toothX(idx, r.teeth.length) - 24;
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#111827')
        .text(code, x, r.position === 'upper' ? cellY - 13 : cellY + 40, {
          width: 36,
          align: 'center',
          lineBreak: false,
        });
      drawTooth(doc, code, data.teeth[code], x, cellY, r.position);
    });
  });
  doc.restore();
  doc.y = top + rows.length * rowH * k + 8;
  doc.x = MARGIN_X;
}

function drawLegend(doc: Doc, W: number): void {
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#111827')
    .text('Leyenda', MARGIN_X, doc.y);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#374151')
    .text(
      `${SURFACE_STATES.map((s) => `${LEGEND.surfaceState[s]} (${SURFACE_STYLE[s].pattern === 'solid' ? 'relleno' : { hatch: 'rayas', dots: 'puntos', cross: 'cuadrícula cruzada', grid: 'cuadrícula' }[SURFACE_STYLE[s].pattern]})`).join(' · ')}. Pieza ausente: aspa · Implante: I · Resto radicular: R · Corona: círculo · Endodoncia: línea vertical · Prótesis: barra · Sin erupcionar: borde punteado. Numeración FDI; mesial hacia la línea media.`,
      MARGIN_X,
      doc.y + 2,
      { width: W },
    );
  doc.moveDown(0.8);
}

function drawLines(
  doc: Doc,
  W: number,
  title: string,
  empty: string,
  lines: { tooth: string; text: string }[],
): void {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#111827')
    .text(title, MARGIN_X, doc.y);
  doc.font('Helvetica').fontSize(9).fillColor('#111827');
  if (lines.length === 0) doc.text(empty, MARGIN_X, doc.y + 2, { width: W });
  for (const f of lines) {
    if (doc.y > doc.page.height - 100) doc.addPage();
    doc
      .font('Helvetica-Bold')
      .text(`Pieza ${f.tooth}: `, MARGIN_X, doc.y + 2, {
        continued: true,
        width: W,
      })
      .font('Helvetica')
      .text(f.text);
  }
}

function drawFindings(
  doc: Doc,
  data: OdontogramData,
  W: number,
  title: string,
  empty: string,
): void {
  drawLines(doc, W, title, empty, describeFindings(data));
  if (data.notes) {
    doc
      .moveDown(0.6)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('Notas generales', MARGIN_X, doc.y);
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(data.notes, MARGIN_X, doc.y + 2, { width: W });
  }
}

/** Pie en todas las páginas (dentro del margen inferior, sin provocar otra página). */
function drawFooter(
  doc: Doc,
  generatedAt: Date,
  generatedBy: string,
  hashes: string[],
  W: number,
): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 52;
    doc.font('Helvetica').fontSize(7.5).fillColor('#4b5563');
    doc.text(
      `Generado el ${fmt(generatedAt)} por ${generatedBy} desde ApiDental. Documento de apoyo: registra lo declarado por el profesional; no incluye recomendaciones, tratamientos ni presupuestos. No es una firma digital, legal ni clínica.${hashes.length ? ` Huella de integridad (SHA-256): ${hashes.join(' · ')}.` : ''}`,
      MARGIN_X,
      y,
      { width: W - 60, lineBreak: true, height: 36 },
    );
    doc.text(
      `Página ${i + 1} de ${range.count}`,
      doc.page.width - MARGIN_X - 56,
      y,
      {
        width: 56,
        align: 'right',
        lineBreak: false,
      },
    );
  }
}

function newDoc(
  title: string,
  author: string,
): { doc: Doc; done: Promise<Buffer> } {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 48, bottom: 60, left: MARGIN_X, right: MARGIN_X },
    bufferPages: true,
    compress: false,
    info: {
      Title: title,
      Author: author,
      Subject: 'Odontograma (formato clínico por validar)',
      Creator: 'ApiDental',
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}

function drawHeader(
  doc: Doc,
  clinicName: string,
  subtitle: string,
  W: number,
): void {
  doc
    .font('Helvetica-Bold')
    .fontSize(17)
    .fillColor('#111827')
    .text(clinicName, MARGIN_X, 48);
  doc
    .font('Helvetica')
    .fontSize(12)
    .fillColor('#374151')
    .text(subtitle, MARGIN_X, doc.y + 1);
  doc.moveDown(0.6);
  const noticeY = doc.y;
  doc.rect(MARGIN_X, noticeY, W, 30).fillAndStroke('#fff7e0', '#b45309');
  doc
    .fillColor('#7c2d12')
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .text(
      `FORMATO CLÍNICO POR VALIDAR. ${FORMAT_NOTICE.replace('Formato clínico por validar. ', '')}`,
      MARGIN_X + 8,
      noticeY + 6,
      {
        width: W - 16,
      },
    );
  doc.y = noticeY + 40;
}

function drawInfo(doc: Doc, info: [string, string][], W: number): void {
  doc.fillColor('#111827').fontSize(10);
  for (const [k, v] of info) {
    const y = doc.y;
    doc
      .font('Helvetica-Bold')
      .text(`${k}:`, MARGIN_X, y, { width: 120, continued: false });
    doc.font('Helvetica').text(v, MARGIN_X + 124, y, { width: W - 124 });
    doc.moveDown(0.15);
  }
  doc.moveDown(0.6);
}

export interface VisitOdontogramPdfInput {
  clinicName: string;
  patient: OdontogramPdfInput['patient'];
  visit: { number: number; date: Date; dentist: string };
  phases: {
    label: string;
    version: number;
    stateLabel: string;
    savedAt: Date;
    hash: string | null;
    dentition: Dentition;
    data: OdontogramData;
  }[];
  generatedAt: Date;
  generatedBy: string;
}

/**
 * PDF del odontograma de una visita, como en la ficha en papel: odontograma de diagnóstico (cómo llegó el paciente) y
 * odontograma post tratamiento (cómo salió), cada uno con sus hallazgos, y al final las piezas que cambiaron.
 */
export function renderVisitOdontogramPdf(
  input: VisitOdontogramPdfInput,
): Promise<Buffer> {
  const { doc, done } = newDoc(
    `Odontograma · visita ${input.visit.number}`,
    input.clinicName,
  );
  const W = doc.page.width - MARGIN_X * 2;
  drawHeader(
    doc,
    input.clinicName,
    `Odontograma de la visita N° ${input.visit.number}`,
    W,
  );
  drawInfo(
    doc,
    [
      ['Paciente', input.patient.fullName],
      ['Documento', input.patient.document ?? 'No registrado'],
      [
        'Nacimiento',
        input.patient.birthDate
          ? `${input.patient.birthDate}${input.patient.age !== null ? ` (${input.patient.age} años)` : ''}`
          : 'No registrado',
      ],
      ['Fecha de la visita', fmt(input.visit.date)],
      ['Profesional', input.visit.dentist],
    ],
    W,
  );
  input.phases.forEach((ph, i) => {
    if (i > 0) doc.addPage();
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor('#111827')
      .text(ph.label, MARGIN_X, doc.y);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#374151')
      .text(
        `Versión ${ph.version} · ${ph.stateLabel} · ${fmt(ph.savedAt)} · ${LEGEND.dentition[ph.dentition]}`,
        MARGIN_X,
        doc.y + 1,
      );
    doc.moveDown(0.6);
    drawChart(doc, ph.dentition, ph.data, W);
    drawFindings(
      doc,
      ph.data,
      W,
      'Hallazgos por pieza',
      'Sin hallazgos registrados.',
    );
    doc.moveDown(0.8);
  });
  if (input.phases.length === 2) {
    doc.moveDown(0.4);
    drawLines(
      doc,
      W,
      'Piezas que cambiaron entre el diagnóstico y el post tratamiento',
      'No hubo cambios entre ambos odontogramas.',
      diffOdontogram(input.phases[0]!.data, input.phases[1]!.data).map((c) => ({
        tooth: c.tooth,
        text: `antes: ${c.before} → después: ${c.after}`,
      })),
    );
  }
  doc.moveDown(0.8);
  drawLegend(doc, W);
  drawFooter(
    doc,
    input.generatedAt,
    input.generatedBy,
    input.phases.map((p) => p.hash).filter((h): h is string => !!h),
    W,
  );
  doc.end();
  return done;
}

/**
 * Exportación PDF del odontograma: identidad de la clínica y del paciente, fecha, profesional, versión, aviso de
 * "formato clínico por validar", dibujo con patrones (legible en blanco y negro) y el detalle de hallazgos en texto.
 * No incluye recomendaciones, tratamientos ni presupuestos. NO es una firma digital, legal ni clínica.
 */
export function renderOdontogramPdf(
  input: OdontogramPdfInput,
): Promise<Buffer> {
  const { doc, done } = newDoc(
    `Odontograma · versión ${input.version.number}`,
    input.clinicName,
  );
  const W = doc.page.width - MARGIN_X * 2;
  drawHeader(doc, input.clinicName, 'Odontograma', W);
  const info: [string, string][] = [
    ['Paciente', input.patient.fullName],
    ['Documento', input.patient.document ?? 'No registrado'],
    [
      'Nacimiento',
      input.patient.birthDate
        ? `${input.patient.birthDate}${input.patient.age !== null ? ` (${input.patient.age} años)` : ''}`
        : 'No registrado',
    ],
    [
      'Versión',
      `${input.version.number} · ${input.version.stateLabel} · ${input.version.kindLabel}`,
    ],
    ['Fecha de la versión', fmt(input.version.savedAt)],
    ['Profesional', input.version.author],
    ['Dentición', LEGEND.dentition[input.dentition]],
  ];
  if (input.version.reason)
    info.push(['Motivo del cambio', input.version.reason]);
  drawInfo(doc, info, W);
  drawChart(doc, input.dentition, input.data, W);
  drawLegend(doc, W);
  drawFindings(
    doc,
    input.data,
    W,
    'Hallazgos registrados por pieza',
    'No hay hallazgos registrados en esta versión.',
  );
  drawFooter(
    doc,
    input.generatedAt,
    input.generatedBy,
    input.version.hash ? [input.version.hash] : [],
    W,
  );
  doc.end();
  return done;
}
