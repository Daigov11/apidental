import { assignmentKey } from './assignment-key.js';

describe('assignmentKey', () => {
  it('distingue plataforma, clínica completa y sede', () => {
    const base = { roleId: 'r' };
    const keys = [
      assignmentKey('u', { ...base, clinicId: null, branchId: null }),
      assignmentKey('u', { ...base, clinicId: 'c', branchId: null }),
      assignmentKey('u', { ...base, clinicId: 'c', branchId: 'b' }),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('es determinista', () => {
    const g = { roleId: 'r', clinicId: 'c', branchId: 'b' };
    expect(assignmentKey('u', g)).toBe(assignmentKey('u', g));
  });
});
