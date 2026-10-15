import PDFDocument from 'pdfkit';
import { DEMO_MARK } from './integrations.constants.js';

interface Input {
  clinicName: string;
  concept: string;
  createdAt: Date;
  doc: { number: string; typeLabel: string; statusLabel: string; customer: { name: string; docType: string; docNumber: string }; amountText: string; igvText: string; subtotalText: string; providerRef: string | null };
}

const when = (d: Date) => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'long', timeStyle: 'short' }).format(d);

/** PDF del comprobante SIMULADO: marca de agua diagonal y leyenda en cabecera y pie. No tiene validez tributaria. */
export function renderDocumentPdf(i: Input): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `Comprobante simulado ${i.doc.number}`, Author: 'ApiDental (simulador)' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const w = doc.page.width;
    const h = doc.page.height;

    doc.save();
    doc.rotate(-35, { origin: [w / 2, h / 2] });
    doc.fillColor('#CC3B32').opacity(0.14).font('Helvetica-Bold').fontSize(34);
    for (const dy of [-120, 0, 120]) doc.text(DEMO_MARK, 0, h / 2 + dy - 20, { width: w, align: 'center', lineBreak: false });
    doc.restore();
    doc.opacity(1);

    doc.rect(36, 36, w - 72, 22).fill('#CC3B32');
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11).text(DEMO_MARK, 36, 42, { width: w - 72, align: 'center' });
    doc.fillColor('#141E26').font('Helvetica-Bold').fontSize(15).text(i.doc.typeLabel.toUpperCase(), 36, 72, { align: 'center', width: w - 72 });
    doc.fontSize(13).text(i.doc.number, { align: 'center', width: w - 72 });
    doc.moveDown(0.8).font('Helvetica').fontSize(10);
    const row = (a: string, b: string) => { doc.font('Helvetica-Bold').text(`${a}: `, { continued: true }).font('Helvetica').text(b); };
    row('Emisor', `${i.clinicName} (demostración)`);
    row('Fecha', when(i.createdAt));
    row('Cliente', i.doc.customer.name);
    row('Documento', `${i.doc.customer.docType} ${i.doc.customer.docNumber}`);
    row('Estado', i.doc.statusLabel);
    if (i.doc.providerRef) row('Referencia del simulador', i.doc.providerRef);
    doc.moveDown(0.8).font('Helvetica-Bold').text('Concepto');
    doc.font('Helvetica').text(i.concept);
    doc.moveDown(0.8);
    row('Subtotal', i.doc.subtotalText);
    row('IGV (18 %, incluido)', i.doc.igvText);
    doc.font('Helvetica-Bold').fontSize(13).text(`TOTAL: ${i.doc.amountText}`);
    doc.font('Helvetica').fontSize(8).fillColor('#475965').text('Documento generado por un SIMULADOR de demostración. No fue enviado a SUNAT ni a ningún proveedor real y no tiene validez tributaria. Datos ficticios.', 36, h - 70, { width: w - 72, align: 'center' });
    doc.end();
  });
}
