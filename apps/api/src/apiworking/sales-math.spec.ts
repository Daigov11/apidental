import { inflateRawSync } from 'node:zlib';
import { buildXlsx } from '../common/utils/xlsx.js';
import { paymentsOf, splitDiscount } from './apiworking-sales.service.js';

describe('descuento repartido entre las líneas', () => {
  it('suma exactamente el descuento, en proporción al importe de cada línea', () => {
    expect(splitDiscount([20_000, 5_000], 2_500)).toEqual([2_000, 500]);
    const parts = splitDiscount([3_333, 3_333, 3_334], 1_000);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_000);
    for (const [i, t] of [3_333, 3_333, 3_334].entries()) expect(parts[i]).toBeLessThan(t);
  });
  it('sin descuento, todo en cero', () => {
    expect(splitDiscount([1_000, 2_000], 0)).toEqual([0, 0]);
  });
});

describe('partes del pago', () => {
  it('un solo medio por el total, o los medios guardados', () => {
    expect(paymentsOf({ payments: null, paymentMethodId: '1', totalCents: 500 })).toEqual([{ idMetodoPago: '1', amountCents: 500 }]);
    const two = [{ idMetodoPago: '1', amountCents: 300 }, { idMetodoPago: '6', amountCents: 200 }];
    expect(paymentsOf({ payments: two, paymentMethodId: '1', totalCents: 500 })).toEqual(two);
  });
});

describe('Excel (.xlsx) sin dependencias', () => {
  /** Lee un ZIP: nombre -> contenido. */
  const unzip = (buf: Buffer) => {
    const out = new Map<string, string>();
    let i = 0;
    while (buf.readUInt32LE(i) === 0x04034b50) {
      const method = buf.readUInt16LE(i + 8);
      const size = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extra = buf.readUInt16LE(i + 28);
      const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
      const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
      out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
      i += 30 + nameLen + extra + size;
    }
    return out;
  };

  it('arma un libro válido: partes requeridas, texto escapado y números como números', () => {
    const x = buildXlsx('Ventas', ['Cliente', 'Total (S/)'], [['Ñandú & <Cía>', 12.5], ['Otro', null]]);
    expect(x.subarray(0, 2).toString()).toBe('PK');
    const files = unzip(x);
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('Ñandú &amp; &lt;Cía&gt;');
    expect(sheet).toContain('<c r="B2"><v>12.5</v></c>');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
  });
});
