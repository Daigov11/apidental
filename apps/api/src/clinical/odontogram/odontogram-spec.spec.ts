import { describe, expect, it } from 'vitest';
import {
  emptyOdontogram,
  normalizeOdontogram,
  odontogramHash,
  odontogramSpec,
  PERMANENT_TEETH,
  PRIMARY_TEETH,
  surfaceSide,
} from './odontogram-spec.js';
import { renderOdontogramSvg, rowsFor } from './odontogram-svg.js';

const doc = (teeth: Record<string, unknown>, notes?: string) => ({
  schema: 'apidental.odontogram',
  schemaVersion: 1,
  teeth,
  ...(notes ? { notes } : {}),
});

describe('odontograma: estructura FDI', () => {
  it('numeración: 32 piezas permanentes y 20 temporales, sin repetidos', () => {
    expect(PERMANENT_TEETH).toHaveLength(32);
    expect(PRIMARY_TEETH).toHaveLength(20);
    expect(new Set([...PERMANENT_TEETH, ...PRIMARY_TEETH]).size).toBe(52);
    expect(odontogramSpec().layout.permanent.upper).toEqual([
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
    ]);
  });

  it('normaliza: ordena, quita valores por defecto y recorta texto, de modo que lo igual tiene la misma huella', () => {
    const a = normalizeOdontogram(
      doc(
        {
          '36': { status: 'ABSENT' },
          '16': {
            surfaces: {
              O: { state: 'CARIES', note: '  x  ' },
              M: { state: 'SEALANT' },
            },
            marks: ['ENDODONTIC', 'CROWN'],
          },
          '21': { status: 'PRESENT' },
        },
        '  n  ',
      ),
      'PERMANENT',
    );
    const b = normalizeOdontogram(
      doc(
        {
          '16': {
            marks: ['CROWN', 'ENDODONTIC'],
            surfaces: {
              M: { state: 'SEALANT' },
              O: { note: 'x', state: 'CARIES' },
            },
          },
          '36': { status: 'ABSENT' },
        },
        'n',
      ),
      'PERMANENT',
    );
    expect(a).toEqual(b);
    expect(Object.keys(a.teeth)).toEqual(['16', '36']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const h = (data: unknown) =>
      odontogramHash({
        patientId: 'p',
        version: 2,
        dentition: 'PERMANENT',
        data,
      });
    expect(h(a)).toBe(h(b));
    expect(h(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(h(a)).not.toBe(
      odontogramHash({
        patientId: 'p',
        version: 3,
        dentition: 'PERMANENT',
        data: a,
      }),
    );
    expect(normalizeOdontogram(emptyOdontogram(), 'PERMANENT')).toEqual(
      emptyOdontogram(),
    );
  });

  it('rechaza lo inválido sin repetir el valor enviado', () => {
    const secret = 'DATO-SENSIBLE-123';
    for (const bad of [
      doc({ '99': {} }),
      doc({ '16': { status: secret } }),
      doc({ '16': { surfaces: { O: { state: secret } } } }),
      { ...doc({}), [secret]: 1 },
      doc({ '36': { status: 'ABSENT', marks: ['CROWN'] } }),
      doc({ '16': { note: secret.repeat(50) } }),
    ]) {
      try {
        normalizeOdontogram(bad, 'PERMANENT');
        throw new Error('debía fallar');
      } catch (e) {
        expect(String((e as { message?: string }).message)).not.toContain(
          secret,
        );
        expect((e as { status?: number }).status).toBe(400);
      }
    }
    expect(() => normalizeOdontogram(doc({ '55': {} }), 'PERMANENT')).toThrow();
    expect(() =>
      normalizeOdontogram(doc({ '55': {}, '16': {} }), 'MIXED'),
    ).not.toThrow();
  });

  it('geometría: vestibular arriba en la arcada superior y abajo en la inferior; mesial hacia la línea media', () => {
    expect(surfaceSide('16', 'V')).toBe('top');
    expect(surfaceSide('16', 'L')).toBe('bottom');
    expect(surfaceSide('46', 'V')).toBe('bottom');
    expect(surfaceSide('46', 'L')).toBe('top');
    expect(surfaceSide('16', 'M')).toBe('right'); // cuadrante 1 (derecha del paciente, a la izquierda del dibujo): la línea media queda a la derecha
    expect(surfaceSide('26', 'M')).toBe('left');
    expect(surfaceSide('36', 'M')).toBe('left');
    expect(surfaceSide('46', 'M')).toBe('right');
    expect(surfaceSide('16', 'D')).toBe('left');
    expect(surfaceSide('16', 'O')).toBe('center');
  });

  it('SVG: filas por dentición, una pieza por grupo accesible, texto escapado y sin scripts', () => {
    expect(rowsFor('PERMANENT')).toHaveLength(2);
    expect(rowsFor('MIXED')).toHaveLength(4);
    const data = normalizeOdontogram(
      doc({ '16': { surfaces: { O: { state: 'CARIES' } }, note: '<b>x</b>' } }),
      'PERMANENT',
    );
    const svg = renderOdontogramSvg(data, 'PERMANENT', { title: 'A & B <t>' });
    expect(svg.match(/id="tooth-\d\d"/g)).toHaveLength(32);
    expect(svg).toContain(
      'aria-label="Pieza 16: Presente, Oclusal / incisal Caries"',
    );
    expect(svg).toContain('A &amp; B &lt;t&gt;');
    expect(svg).not.toMatch(/<script|<b>/);
    expect(
      renderOdontogramSvg(emptyOdontogram(), 'MIXED').match(/id="tooth-\d\d"/g),
    ).toHaveLength(52);
  });
});
