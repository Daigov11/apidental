import {
  CARE_ATTENDANCE_PERMISSIONS,
  CLINIC_GOVERNANCE_PERMISSIONS,
  CLINICAL_PERMISSIONS,
  PATIENT_DATA_PERMISSIONS,
  PERMISSIONS,
  ROLE_DEFINITIONS,
} from './permissions.js';

describe('catálogo RBAC', () => {
  const roles = new Map(ROLE_DEFINITIONS.map((r) => [r.code, r]));

  it('define los seis roles iniciales más el Director Clínico', () => {
    expect([...roles.keys()].sort()).toEqual(
      ['ASSISTANT', 'CASHIER', 'CLINIC_ADMIN', 'CLINICAL_DIRECTOR', 'DENTIST', 'PLATFORM_ADMIN', 'RECEPTIONIST'].sort(),
    );
  });

  describe('acceso clínico (3.1)', () => {
    const perms = (code: string) => roles.get(code)!.permissions as readonly string[];
    const holders = (p: string) => ROLE_DEFINITIONS.filter((r) => (r.permissions as readonly string[]).includes(p)).map((r) => r.code).sort();

    it('existen los cinco permisos nuevos', () => {
      for (const p of ['clinical:read', 'clinical:write', 'clinical:read_limited', 'clinical:read_all', 'care:assign']) {
        expect(PERMISSIONS).toHaveProperty(p);
      }
    });

    it('clinical:read_all es exclusivo del Director Clínico', () => {
      expect(holders('clinical:read_all')).toEqual(['CLINICAL_DIRECTOR']);
    });

    it('clinical:read y clinical:write son exclusivos del odontólogo; clinical:read_limited, del asistente', () => {
      expect(holders('clinical:read')).toEqual(['DENTIST']);
      expect(holders('clinical:write')).toEqual(['DENTIST']);
      expect(holders('clinical:read_limited')).toEqual(['ASSISTANT']);
    });

    it('el Director lee pero no escribe información clínica', () => {
      expect(perms('CLINICAL_DIRECTOR')).not.toContain('clinical:write');
      expect(perms('CLINICAL_DIRECTOR')).not.toContain('clinical:read');
    });

    it('plataforma, administración y caja no tienen NINGÚN permiso clínico', () => {
      for (const code of ['PLATFORM_ADMIN', 'CLINIC_ADMIN', 'CASHIER']) {
        for (const p of CLINICAL_PERMISSIONS) expect(perms(code), `${code} ${p}`).not.toContain(p);
      }
    });

    it('recepción solo tiene clinical:view (vista de solo lectura): ningún otro permiso clínico ni de escritura', () => {
      expect(holders('clinical:view')).toEqual(['RECEPTIONIST']);
      for (const p of CLINICAL_PERMISSIONS.filter((x) => x !== 'clinical:view')) expect(perms('RECEPTIONIST'), `RECEPTIONIST ${p}`).not.toContain(p);
    });

    it('clinical:view no exige que quien asigna el rol la posea (no es una escalada)', () => {
      expect(CARE_ATTENDANCE_PERMISSIONS as readonly string[]).toContain('clinical:view');
    });

    it('care:assign (acto administrativo) lo tienen administración, recepción y Director; la plataforma, no', () => {
      expect(holders('care:assign')).toEqual(['CLINICAL_DIRECTOR', 'CLINIC_ADMIN', 'RECEPTIONIST']);
    });

    it('el catálogo de procedimientos: lo configuran administración y Director; lo ven además los odontólogos; la plataforma y el asistente no', () => {
      expect(holders('procedure:manage')).toEqual(['CLINICAL_DIRECTOR', 'CLINIC_ADMIN']);
      expect(holders('procedure:read')).toEqual(['CLINICAL_DIRECTOR', 'CLINIC_ADMIN', 'DENTIST']);
    });

    it('los permisos de atención que un administrador puede conferir nunca incluyen clinical:read_all', () => {
      expect(CARE_ATTENDANCE_PERMISSIONS as readonly string[]).not.toContain('clinical:read_all');
    });
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

  it('aún no existen permisos de módulos clínicos concretos (odontograma, diagnósticos, tratamientos, historia)', () => {
    expect(Object.keys(PERMISSIONS).some((p) => /^(odontogram|diagnosis|treatment|history|visit|note)/.test(p))).toBe(false);
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
