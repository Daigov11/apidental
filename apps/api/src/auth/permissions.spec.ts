import { CLINIC_GOVERNANCE_PERMISSIONS, PATIENT_DATA_PERMISSIONS, PERMISSIONS, ROLE_DEFINITIONS } from './permissions.js';

describe('catálogo RBAC', () => {
  const roles = new Map(ROLE_DEFINITIONS.map((r) => [r.code, r]));

  it('define los seis roles iniciales más el Director Clínico', () => {
    expect([...roles.keys()].sort()).toEqual(
      ['ASSISTANT', 'CASHIER', 'CLINIC_ADMIN', 'CLINICAL_DIRECTOR', 'DENTIST', 'PLATFORM_ADMIN', 'RECEPTIONIST'].sort(),
    );
  });

  it('clinical:read_all NO existe todavía en el catálogo (llega en 3.1 con su justificación y auditoría)', () => {
    expect(PERMISSIONS).not.toHaveProperty('clinical:read_all');
    for (const role of ROLE_DEFINITIONS) {
      expect((role.permissions as readonly string[]).some((p) => p.startsWith('clinical:'))).toBe(false);
    }
  });

  describe('aprovisionamiento por invitación (3.0)', () => {
    const perms = (code: string) => roles.get(code)!.permissions as readonly string[];

    it('la plataforma gestiona invitaciones pero NO tiene el gobierno de la clínica', () => {
      expect(perms('PLATFORM_ADMIN')).toEqual(expect.arrayContaining(['invitation:read', 'invitation:manage']));
      for (const p of CLINIC_GOVERNANCE_PERMISSIONS) expect(perms('PLATFORM_ADMIN')).not.toContain(p);
    });

    it('solo el administrador de clínica registra el aprovisionamiento formal', () => {
      for (const role of ROLE_DEFINITIONS) {
        expect(role.permissions.includes('provisioning:record')).toBe(role.code === 'CLINIC_ADMIN');
      }
    });

    it('solo el Director Clínico puede designar a otro Director', () => {
      for (const role of ROLE_DEFINITIONS) {
        expect(role.permissions.includes('director:manage')).toBe(role.code === 'CLINICAL_DIRECTOR');
      }
    });

    it('ni el administrador de clínica ni el Director Clínico escriben datos de pacientes por este rol de gobierno', () => {
      expect(perms('CLINICAL_DIRECTOR')).not.toContain('patient:write');
      expect(perms('CLINICAL_DIRECTOR')).not.toContain('invitation:manage');
      expect(perms('CLINIC_ADMIN')).not.toContain('director:manage');
    });
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
    expect(Object.keys(PERMISSIONS).some((p) => /^(clinical|odontogram|diagnosis|treatment|history)/.test(p))).toBe(false);
  });

  it('el administrador de plataforma NO tiene ningún permiso sobre datos de pacientes', () => {
    const platform = roles.get('PLATFORM_ADMIN')!.permissions as readonly string[];
    for (const p of PATIENT_DATA_PERMISSIONS) expect(platform).not.toContain(p);
    expect(platform.length).toBeGreaterThan(0);
  });

  describe('política temporal de acceso a pacientes', () => {
    const perms = (code: string) => roles.get(code)!.permissions as readonly string[];

    it('administración y recepción gestionan pacientes, contactos, consentimientos y adjuntos', () => {
      for (const code of ['CLINIC_ADMIN', 'RECEPTIONIST']) {
        for (const p of PATIENT_DATA_PERMISSIONS) expect(perms(code)).toContain(p);
      }
    });

    it('odontólogo y asistente solo leen (demografía, consentimientos, adjuntos)', () => {
      for (const code of ['DENTIST', 'ASSISTANT']) {
        expect(perms(code)).toEqual(expect.arrayContaining(['patient:read', 'consent:read', 'attachment:read']));
        for (const w of ['patient:write', 'consent:write', 'attachment:write']) expect(perms(code)).not.toContain(w);
      }
    });

    it('el cajero solo tiene lectura mínima de identificación/contacto', () => {
      const patientPerms = perms('CASHIER').filter((p) => (PATIENT_DATA_PERMISSIONS as readonly string[]).includes(p));
      expect(patientPerms).toEqual(['patient:read_basic']);
    });

    it('todo rol que lee la ficha completa también tiene la lectura mínima', () => {
      for (const role of ROLE_DEFINITIONS) {
        if (role.permissions.includes('patient:read')) expect(role.permissions).toContain('patient:read_basic');
      }
    });
  });
});
