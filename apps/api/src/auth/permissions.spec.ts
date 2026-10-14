import { PERMISSIONS, ROLE_DEFINITIONS } from './permissions.js';

describe('catálogo RBAC', () => {
  const roles = new Map(ROLE_DEFINITIONS.map((r) => [r.code, r]));

  it('define los seis roles iniciales', () => {
    expect([...roles.keys()].sort()).toEqual(
      ['ASSISTANT', 'CASHIER', 'CLINIC_ADMIN', 'DENTIST', 'PLATFORM_ADMIN', 'RECEPTIONIST'].sort(),
    );
  });

  it('todo permiso referenciado por un rol existe en el catálogo', () => {
    for (const role of ROLE_DEFINITIONS) {
      for (const p of role.permissions) expect(PERMISSIONS).toHaveProperty(p);
    }
  });

  it('solo el administrador de plataforma tiene alcance PLATFORM y gestiona clínicas', () => {
    expect(ROLE_DEFINITIONS.filter((r) => r.scope === 'PLATFORM').map((r) => r.code)).toEqual(['PLATFORM_ADMIN']);
    for (const role of ROLE_DEFINITIONS) {
      expect(role.permissions.includes('clinic:manage')).toBe(role.code === 'PLATFORM_ADMIN');
    }
  });

  it('los roles operativos no administran usuarios ni asignaciones', () => {
    for (const code of ['RECEPTIONIST', 'DENTIST', 'CASHIER', 'ASSISTANT']) {
      const perms = roles.get(code)!.permissions;
      expect(perms).not.toContain('user:manage');
      expect(perms).not.toContain('assignment:manage');
      expect(perms).not.toContain('audit:read');
    }
  });

  it('ningún rol tiene permisos clínicos (aún no existen módulos clínicos)', () => {
    expect(Object.keys(PERMISSIONS).some((p) => /^(patient|clinical|odontogram|attachment)/.test(p))).toBe(false);
  });
});
