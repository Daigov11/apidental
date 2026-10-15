import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OdontogramSpecLite } from '../src/api/types';
import { activeLayers, OdontogramFigure, surfaceSide, toothSummary } from '../src/pages/odontogram/OdontogramFigure';
import { TOOTH_TEMPLATES } from '../src/pages/odontogram/teeth-data';

const permanent = { upper: ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'], lower: ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'] };
const primary = { upper: ['55', '54', '53', '52', '51', '61', '62', '63', '64', '65'], lower: ['85', '84', '83', '82', '81', '71', '72', '73', '74', '75'] };
const SPEC: OdontogramSpecLite = {
  toothStatuses: [{ code: 'PRESENT', label: 'Presente' }, { code: 'ABSENT', label: 'Ausente' }],
  surfaces: [{ code: 'M', label: 'Mesial' }, { code: 'D', label: 'Distal' }, { code: 'O', label: 'Oclusal / incisal' }, { code: 'V', label: 'Vestibular' }, { code: 'L', label: 'Lingual / palatina' }],
  surfaceStates: [{ code: 'CARIES', label: 'Caries', color: '#b3261e', pattern: 'hatch' }],
  marks: [{ code: 'CROWN', label: 'Corona' }],
  layout: { permanent, primary },
  cell: { size: 36, polygons: { top: [[0, 0]], bottom: [[0, 36]], left: [[0, 0]], right: [[36, 0]], center: [[12, 12]] } },
};

describe('Odontograma: dibujo', () => {
  it('ubica las superficies según arcada y lado (mesial hacia la línea media)', () => {
    expect(surfaceSide('16', 'O')).toBe('center');
    expect(surfaceSide('16', 'V')).toBe('top');
    expect(surfaceSide('36', 'V')).toBe('bottom');
    expect(surfaceSide('16', 'M')).toBe('right');
    expect(surfaceSide('26', 'M')).toBe('left');
    expect(surfaceSide('46', 'M')).toBe('right');
  });

  it('describe la pieza con palabras de la clínica', () => {
    expect(toothSummary('16', { surfaces: { O: { state: 'CARIES' } }, marks: ['CROWN'] }, SPEC)).toBe('Pieza 16: presente, oclusal / incisal caries, corona');
    expect(toothSummary('36', { status: 'ABSENT' }, SPEC)).toBe('Pieza 36: Ausente');
  });

  it('activa las capas del diente según lo registrado', () => {
    expect([...activeLayers(undefined, 'side')]).toEqual(['base', 'tooth', 'pulp']);
    const side = activeLayers({ surfaces: { O: { state: 'CARIES' }, M: { state: 'RESTORATION' }, V: { state: 'SEALANT' } }, marks: ['CROWN', 'ENDODONTIC'] }, 'side');
    expect(side).toEqual(new Set(['base', 'tooth', 'endo', 'caries-occlusal', 'fill-mesial', 'sealant', 'crown']));
    expect(activeLayers({ status: 'ABSENT', surfaces: { O: { state: 'CARIES' } } }, 'side')).toEqual(new Set(['base', 'absent']));
    expect(activeLayers({ status: 'IMPLANT' }, 'side')).toEqual(new Set(['base', 'implant']));
    expect(activeLayers({ status: 'ROOT_REMNANT' }, 'side')).toEqual(new Set(['base', 'radix']));
    expect(activeLayers({ surfaces: { M: { state: 'FRACTURE' }, O: { state: 'FRACTURE' } } }, 'side').has('broken-mesial-incisal')).toBe(true);
    expect(activeLayers({ surfaces: { L: { state: 'CARIES' } } }, 'occl').has('caries-lingual')).toBe(true);
    expect([...activeLayers({ status: 'ABSENT' }, 'occl')]).toEqual(['base']);
  });

  it('las plantillas traen las capas que el panel activa (vista lateral y oclusal)', () => {
    for (const code of ['11', '16', '36', '54', '74']) expect(Object.keys(TOOTH_TEMPLATES[code]!.layers)).toEqual(expect.arrayContaining(['base', 'tooth', 'pulp', 'caries-mesial', 'fill-occlusal', 'crown', 'implant']));
    for (const code of ['14_occl', '18_occl', '38_occl', '75_occl']) expect(Object.keys(TOOTH_TEMPLATES[code]!.layers)).toEqual(expect.arrayContaining(['base', 'tooth', 'caries-occlusal', 'fill-lingual']));
    expect(TOOTH_TEMPLATES['11_occl']).toBeUndefined(); // los dientes anteriores no tienen vista oclusal
  });

  it('es operable: cada pieza es un botón, se elige con clic o Enter y las flechas mueven el foco', async () => {
    const onSelect = vi.fn();
    render(<OdontogramFigure spec={SPEC} dentition="PERMANENT" teeth={{ '11': { surfaces: { O: { state: 'CARIES' } } } }} selected="11" onSelect={onSelect} />);
    const tooth = screen.getByRole('button', { name: 'Pieza 11: presente, oclusal / incisal caries' });
    expect(tooth).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button')).toHaveLength(32);
    tooth.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('11');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Pieza 21: presente' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Pieza 36: presente' }));
    expect(onSelect).toHaveBeenLastCalledWith('36');
  });

  it('en dentición mixta dibuja permanentes y temporales, y sin onSelect es solo lectura', () => {
    const { rerender } = render(<OdontogramFigure spec={SPEC} dentition="MIXED" teeth={{}} selected={null} onSelect={() => undefined} />);
    expect(screen.getAllByRole('button')).toHaveLength(52);
    rerender(<OdontogramFigure spec={SPEC} dentition="PRIMARY" teeth={{}} selected={null} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
