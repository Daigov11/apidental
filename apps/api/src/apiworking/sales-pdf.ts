import PDFDocument from 'pdfkit';

export interface SalesPdfInput { title: string; period: string; header: string[]; rows: string[][]; total: string }

/** Columnas del PDF (A4 horizontal): ancho relativo de cada una; los importes van alineados a la derecha. */
const WIDTHS = [62, 58, 110, 70, 120, 120, 50, 55, 70, 60, 50];
const RIGHT = new Set([6, 7]);

/** Historial de ventas en PDF: tabla con encabezado repetido en cada página y el total del período al final. */
export function renderSalesPdf(input: SalesPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: input.title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const scale = usable / WIDTHS.reduce((a, b) => a + b, 0);
    const widths = WIDTHS.map((w) => w * scale);
    const bottom = () => doc.page.height - doc.page.margins.bottom - 20;

    const row = (cells: string[], bold: boolean) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
      const heights = cells.map((c, i) => doc.heightOfString(c || ' ', { width: widths[i]! - 4 }));
      const h = Math.max(...heights) + 4;
      if (doc.y + h > bottom()) {
        doc.addPage();
        if (!bold) header();
      }
      const y = doc.y;
      let x = left;
      cells.forEach((c, i) => {
        doc.text(c || '', x + 2, y + 2, { width: widths[i]! - 4, align: RIGHT.has(i) ? 'right' : 'left' });
        x += widths[i]!;
      });
      doc.y = y + h;
      doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).lineWidth(0.3).strokeColor('#cccccc').stroke();
    };
    const header = () => row(input.header, true);

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(input.title, left, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(input.period).moveDown(0.5).fillColor('#000');
    header();
    if (input.rows.length === 0) doc.font('Helvetica').fontSize(9).text('No hay ventas en el período.', left, doc.y + 6);
    for (const r of input.rows) row(r, false);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(10).text(input.total, left, doc.y, { width: usable, align: 'right' });
    doc.end();
  });
}
