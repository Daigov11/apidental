import PDFDocument from 'pdfkit';
import { FLOW_LABELS, KIND_LABELS, money } from './cashbox-labels.js';

export interface ReportInput {
  clinicName: string;
  branchName: string;
  from: string;
  to: string;
  generatedBy: string;
  generatedAt: Date;
  accounts: { id: string; name: string }[];
  initial: Map<string, number>;
  movements: {
    flow: 'INCOME' | 'EXPENSE';
    kind: 'NORMAL' | 'OPENING' | 'COUNT_ADJUSTMENT';
    status: 'ACTIVE' | 'VOIDED';
    description: string;
    operationNumber: string | null;
    amountCents: number;
    occurredAt: Date;
    createdById: string;
    accountId: string;
    account: { name: string };
    category: { name: string } | null;
  }[];
  sessions: { openedAt: Date; closedAt: Date | null; closedById: string | null; closeNotes: string | null; accounts: { accountId: string; expectedCents: number | null; countedCents: number | null; differenceCents: number | null }[] }[];
  names: Map<string, string>;
}

const dt = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' });
const day = (d: string) => d.split('-').reverse().join('/');

/** Totales por cuenta del rango: saldo inicial + ingresos − egresos ± ajustes = saldo final. */
export function reportTotals(r: Pick<ReportInput, 'accounts' | 'initial' | 'movements'>) {
  const rows = r.accounts.map((a) => {
    let income = 0, expense = 0, adjust = 0;
    for (const m of r.movements) {
      if (m.accountId !== a.id || m.status !== 'ACTIVE') continue;
      const signed = m.flow === 'INCOME' ? m.amountCents : -m.amountCents;
      if (m.kind !== 'NORMAL') adjust += signed;
      else if (m.flow === 'INCOME') income += m.amountCents;
      else expense += m.amountCents;
    }
    const initial = r.initial.get(a.id) ?? 0;
    return { id: a.id, name: a.name, initial, income, expense, adjust, final: initial + income - expense + adjust };
  }).filter((x) => x.initial || x.income || x.expense || x.adjust);
  const sum = (k: 'initial' | 'income' | 'expense' | 'adjust' | 'final') => rows.reduce((s, x) => s + x[k], 0);
  return { rows, initial: sum('initial'), income: sum('income'), expense: sum('expense'), adjust: sum('adjust'), final: sum('final') };
}

export function renderCashReportPdf(input: ReportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Reporte de caja chica ${input.from} a ${input.to}`, Author: input.clinicName } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 40;
    const width = doc.page.width - 80;
    const bottom = () => doc.page.height - 60;
    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

    /** Fila de tabla con columnas [x relativo, ancho, alineación]. */
    const row = (cols: { w: number; text: string; align?: 'left' | 'right' }[], opts: { bold?: boolean; size?: number; color?: string } = {}) => {
      const size = opts.size ?? 8;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(opts.color ?? '#000000');
      const h = Math.max(...cols.map((c) => doc.heightOfString(c.text, { width: c.w - 4 }))) + 3;
      ensure(h);
      let x = left;
      const y = doc.y;
      for (const c of cols) { doc.text(c.text, x, y, { width: c.w - 4, align: c.align ?? 'left' }); x += c.w; }
      doc.y = y + h;
      doc.x = left;
    };
    const rule = () => { doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#bbbbbb').lineWidth(0.5).stroke(); doc.y += 3; };
    const heading = (t: string) => { ensure(40); doc.moveDown(0.8); doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(t, left, doc.y); doc.moveDown(0.3); };

    doc.font('Helvetica-Bold').fontSize(15).text(input.clinicName, left, 40);
    doc.font('Helvetica').fontSize(10).fillColor('#444444').text(`Reporte de caja chica · ${input.branchName}`);
    doc.text(`Del ${day(input.from)} al ${day(input.to)}`);
    doc.fontSize(8).text(`Generado por ${input.generatedBy} el ${dt.format(input.generatedAt)}`);

    const t = reportTotals(input);
    heading('Resumen');
    const sw = [width * 0.6, width * 0.4];
    row([{ w: sw[0]!, text: 'Saldo inicial' }, { w: sw[1]!, text: money(t.initial), align: 'right' }], { size: 10 });
    row([{ w: sw[0]!, text: 'Ingresos acumulados' }, { w: sw[1]!, text: money(t.income), align: 'right' }], { size: 10 });
    row([{ w: sw[0]!, text: 'Egresos acumulados' }, { w: sw[1]!, text: money(-t.expense), align: 'right' }], { size: 10 });
    if (t.adjust) row([{ w: sw[0]!, text: 'Ajustes de apertura y arqueo' }, { w: sw[1]!, text: money(t.adjust), align: 'right' }], { size: 10 });
    rule();
    row([{ w: sw[0]!, text: 'Saldo final' }, { w: sw[1]!, text: money(t.final), align: 'right' }], { size: 11, bold: true });

    heading('Desglose por medio de pago');
    const aw = [width * 0.28, width * 0.14, width * 0.14, width * 0.14, width * 0.14, width * 0.16];
    row([{ w: aw[0]!, text: 'Cuenta' }, ...['Saldo inicial', 'Ingresos', 'Egresos', 'Ajustes', 'Saldo final'].map((h, i) => ({ w: aw[i + 1]!, text: h, align: 'right' as const }))], { bold: true });
    rule();
    for (const a of t.rows) {
      row([{ w: aw[0]!, text: a.name }, { w: aw[1]!, text: money(a.initial), align: 'right' }, { w: aw[2]!, text: money(a.income), align: 'right' }, { w: aw[3]!, text: money(-a.expense), align: 'right' }, { w: aw[4]!, text: money(a.adjust), align: 'right' }, { w: aw[5]!, text: money(a.final), align: 'right' }]);
    }
    if (t.rows.length === 0) row([{ w: width, text: 'Sin movimientos en el rango.' }], { color: '#666666' });

    if (input.sessions.length) {
      heading('Cierres de caja');
      for (const s of input.sessions) {
        const diff = s.accounts.reduce((sum, a) => sum + (a.differenceCents ?? 0), 0);
        row([{ w: width * 0.55, text: `${dt.format(s.openedAt)} → ${s.closedAt ? dt.format(s.closedAt) : ''} · ${input.names.get(s.closedById ?? '') ?? ''}` }, { w: width * 0.45, text: diff === 0 ? 'Efectivo conciliado' : `Diferencia de arqueo ${money(diff)}${s.closeNotes ? `: ${s.closeNotes}` : ''}`, align: 'right' }]);
      }
    }

    heading('Movimientos');
    const mw = [width * 0.14, width * 0.09, width * 0.31, width * 0.16, width * 0.12, width * 0.18];
    const head = () => { row([{ w: mw[0]!, text: 'Fecha' }, { w: mw[1]!, text: 'Tipo' }, { w: mw[2]!, text: 'Descripción' }, { w: mw[3]!, text: 'Cuenta · usuario' }, { w: mw[4]!, text: 'N.º operación' }, { w: mw[5]!, text: 'Monto', align: 'right' }], { bold: true }); rule(); };
    head();
    if (input.movements.length === 0) row([{ w: width, text: 'Sin movimientos en el rango.' }], { color: '#666666' });
    for (const m of input.movements) {
      if (doc.y + 24 > bottom()) { doc.addPage(); head(); }
      const voided = m.status === 'VOIDED';
      const label = m.kind === 'NORMAL' ? FLOW_LABELS[m.flow] : 'Ajuste';
      const desc = `${m.description}${m.category ? ` (${m.category.name})` : ''}${m.kind !== 'NORMAL' ? ` — ${KIND_LABELS[m.kind]}` : ''}${voided ? ' — ANULADO' : ''}`;
      row([
        { w: mw[0]!, text: dt.format(m.occurredAt) }, { w: mw[1]!, text: label }, { w: mw[2]!, text: desc },
        { w: mw[3]!, text: `${m.account.name} · ${input.names.get(m.createdById) ?? ''}` }, { w: mw[4]!, text: m.operationNumber ?? '' },
        { w: mw[5]!, text: money(m.flow === 'INCOME' ? m.amountCents : -m.amountCents), align: 'right' },
      ], { color: voided ? '#999999' : '#000000' });
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // el pie vive dentro del margen inferior; sin esto pdfkit lo descarta
      doc.font('Helvetica').fontSize(7).fillColor('#777777').text(`Página ${i + 1} de ${range.count} · Los movimientos anulados no se suman a los totales.`, left, doc.page.height - 40, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}
