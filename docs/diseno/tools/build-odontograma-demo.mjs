// Genera los ejemplos del odontograma (SVG y PDF) con datos FICTICIOS de Clínica Demo, a partir de los mismos
// renderizadores que usa la API. Uso (desde la raíz, con la API compilada: npm run build):
//   node docs/diseno/tools/build-odontograma-demo.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../../../apps/api/dist/clinical/odontogram');
const { renderOdontogramSvg } = await import(`${dist}/odontogram-svg.js`);
const { renderOdontogramPdf } = await import(`${dist}/odontogram-pdf.js`);
const { normalizeOdontogram, odontogramHash } = await import(`${dist}/odontogram-spec.js`);

const data = normalizeOdontogram(
  {
    schema: 'apidental.odontogram',
    schemaVersion: 1,
    teeth: {
      '16': { surfaces: { O: { state: 'CARIES', note: 'Hallazgo de demostración (dato ficticio)' } } },
      '26': { surfaces: { O: { state: 'RESTORATION' }, M: { state: 'RESTORATION' } } },
      '14': { surfaces: { O: { state: 'SEALANT' } } },
      '21': { surfaces: { O: { state: 'FRACTURE' } } },
      '36': { status: 'ABSENT' },
      '18': { status: 'UNERUPTED' },
      '24': { marks: ['ENDODONTIC'] },
      '46': { marks: ['CROWN'] },
      '47': { status: 'IMPLANT' },
    },
    notes: 'Odontograma de demostración, rectificado (dato ficticio).',
  },
  'PERMANENT',
);
const savedAt = new Date('2026-10-15T15:00:00Z');
writeFileSync(join(here, '../odontograma-demo.svg'), renderOdontogramSvg(data, 'PERMANENT', { title: 'Odontograma · Lucía Demo Adulta · versión 4 (demostración)', caption: 'Formato clínico por validar. Datos ficticios de Clínica Demo.' }));
const pdf = await renderOdontogramPdf({
  clinicName: 'Clínica Demo',
  patient: { fullName: 'Lucía Demo Adulta', document: 'DNI 90000001', birthDate: '1988-04-12', age: 38 },
  version: { number: 4, stateLabel: 'Corregida', kindLabel: 'Rectificación', savedAt, author: 'Valeria Demo (odontóloga)', hash: odontogramHash({ patientId: 'demo', version: 4, dentition: 'PERMANENT', data }), reason: 'Se agregan dos piezas aclaradas (ejemplo)' },
  dentition: 'PERMANENT',
  data,
  generatedAt: savedAt,
  generatedBy: 'Valeria Demo (odontóloga)',
});
writeFileSync(join(here, '../odontograma-demo.pdf'), pdf);
console.log('Generados docs/diseno/odontograma-demo.svg y odontograma-demo.pdf');
