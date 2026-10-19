import PDFDocument from 'pdfkit';

export interface PrescriptionPdfInput {
  clinicName: string;
  number: string;
  issuedAt: Date;
  patient: { fullName: string; document: string | null; age: number | null };
  prescriber: string;
  diagnosis: string | null;
  notes: string | null;
  items: { medication: string; dose: string | null; frequency: string | null; duration: string | null; instructions: string | null }[];
}

const fmt = (d: Date) => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'long' }).format(d);

/** Receta imprimible (A5 vertical). Sin firma digital: el profesional la firma a mano al imprimirla. */
export function renderPrescriptionPdf(input: PrescriptionPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 40, info: { Title: `Receta ${input.number}`, Author: input.clinicName } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 80;
    doc.font('Helvetica-Bold').fontSize(14).text(input.clinicName, { width });
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Receta ${input.number} · ${fmt(input.issuedAt)}`);
    doc.moveDown(0.6);
    doc.moveTo(40, doc.y).lineTo(40 + width, doc.y).strokeColor('#999999').lineWidth(0.5).stroke();
    doc.moveDown(0.6);

    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text('Paciente: ', { continued: true });
    doc.font('Helvetica').text(input.patient.fullName);
    const meta = [input.patient.document, input.patient.age !== null ? `${input.patient.age} años` : null].filter(Boolean).join(' · ');
    if (meta) doc.fontSize(9).fillColor('#555555').text(meta).fillColor('#000000');
    if (input.diagnosis) {
      doc.moveDown(0.3).fontSize(10).font('Helvetica-Bold').text('Diagnóstico: ', { continued: true });
      doc.font('Helvetica').text(input.diagnosis);
    }

    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).text('Rp.');
    doc.moveDown(0.3);
    input.items.forEach((it, i) => {
      doc.font('Helvetica-Bold').fontSize(10).text(`${i + 1}. ${it.medication}`, { width });
      const line = [it.dose, it.frequency, it.duration].filter(Boolean).join(' · ');
      if (line) doc.font('Helvetica').fontSize(9.5).text(line, { indent: 12, width });
      if (it.instructions) doc.font('Helvetica-Oblique').fontSize(9).fillColor('#444444').text(it.instructions, { indent: 12, width }).fillColor('#000000');
      doc.moveDown(0.5);
    });

    if (input.notes) {
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(9.5).text('Indicaciones generales');
      doc.font('Helvetica').fontSize(9.5).text(input.notes, { width });
    }

    // Firma al pie de la misma página (la receta cabe en una; si es larga, sigue en la siguiente).
    if (doc.y > doc.page.height - 130) doc.addPage();
    const y = doc.page.height - 100;
    doc.moveTo(doc.page.width - 40 - 170, y).lineTo(doc.page.width - 40, y).strokeColor('#000000').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(9).text(input.prescriber, doc.page.width - 40 - 170, y + 4, { width: 170, align: 'center' });
    doc.fontSize(7).fillColor('#777777').text('Documento generado por ApiDental. No incluye firma digital.', 40, doc.page.height - 50, { width, align: 'left', lineBreak: false });
    doc.end();
  });
}
