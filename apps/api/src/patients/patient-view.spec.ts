import { clinicScope } from './patient-access.js';
import { type PatientRow, toBasicView, toFullView } from './patient-view.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ForbiddenException } from '@nestjs/common';

const row: PatientRow = {
  id: 'p1',
  firstName: 'Ana',
  lastName: 'Lopez',
  secondLastName: 'Diaz',
  birthDate: new Date('1990-05-17T00:00:00Z'),
  sex: 'FEMALE',
  status: 'ACTIVE',
  statusReason: null,
  createdBranchId: 'b1',
  createdAt: new Date(),
  updatedAt: new Date(),
  identifiers: [{ type: 'DNI', number: '12345678' }],
  contacts: [
    { id: 'c1', type: 'MOBILE', value: '987654321', label: null, isPrimary: true },
    { id: 'c2', type: 'EMAIL', value: 'ana@x.pe', label: null, isPrimary: true },
    { id: 'c3', type: 'ADDRESS', value: 'Av. Lima 1', label: null, isPrimary: true },
  ],
};

describe('vistas de paciente', () => {
  it('la vista mínima solo contiene identificación y contacto', () => {
    const view = toBasicView(row);
    expect(Object.keys(view).sort()).toEqual(
      ['fullName', 'firstName', 'id', 'identifiers', 'lastName', 'primaryEmail', 'primaryMobile', 'secondLastName', 'status'].sort(),
    );
    expect(JSON.stringify(view)).not.toMatch(/1990|FEMALE|Av\. Lima|createdAt|branch/);
    expect(view.primaryMobile).toBe('987654321');
  });

  it('la vista completa agrega demografía y contactos, sin campos internos', () => {
    const view = toFullView(row);
    expect(view.birthDate).toBe('1990-05-17');
    expect(view.contacts).toHaveLength(3);
    expect(Object.keys(view)).not.toEqual(expect.arrayContaining(['clinicId', 'createdById', 'updatedById']));
  });
});

describe('clinicScope', () => {
  const principal = (clinicId: string | null): AuthPrincipal => ({
    user: { id: 'u', email: 'u@x.pe', firstName: 'U', lastName: 'X' },
    context: { clinicId, branchId: null },
    roles: [],
    permissions: new Set(['patient:read']),
  });

  it('exige contexto de clínica: la plataforma queda fuera aunque tuviera el permiso', () => {
    expect(() => clinicScope(principal(null))).toThrow(ForbiddenException);
    expect(() => clinicScope({ ...principal('c1'), context: null })).toThrow(ForbiddenException);
    expect(clinicScope(principal('c1'))).toEqual({ clinicId: 'c1', branchId: null });
  });
});
