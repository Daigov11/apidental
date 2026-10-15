import { createTestContext, dni, Fixtures, type TestContext, uniq } from './helpers/app.js';

/**
 * Garantías del esquema de pacientes en MySQL 8.4, independientes de la API:
 * aunque un bug o un acceso directo a la BD ignorara las reglas del servicio, estas
 * restricciones siguen protegiendo identidad, aislamiento y no-borrado.
 */
describe('Garantías de BD del módulo de pacientes', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const author = '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11';
  async function patientIn(clinicId: string) {
    return ctx.db.patient.create({ data: { clinicId, firstName: 'Ana', lastName: uniq('Db'), createdById: author } });
  }
  const identifier = (clinicId: string, patientId: string, number: string, over: object = {}) =>
    ctx.db.patientIdentifier.create({
      data: { clinicId, patientId, type: 'DNI', number, activeKey: `${clinicId}|DNI|${number}`, patientTypeKey: `${patientId}|DNI`, createdById: author, ...over },
    });

  describe('identidad inmutable (patient_id)', () => {
    it('el id y la clínica de un paciente no pueden cambiar, ni por SQL directo', async () => {
      const a = await fx.clinic();
      const b = await fx.clinic();
      const p = await patientIn(a.id);
      await expect(ctx.db.$executeRaw`UPDATE patients SET id = ${'11111111-1111-1111-1111-111111111111'} WHERE id = ${p.id}`).rejects.toThrow(/inmutables/);
      await expect(ctx.db.$executeRaw`UPDATE patients SET clinic_id = ${b.id} WHERE id = ${p.id}`).rejects.toThrow(/inmutables/);
      await expect(ctx.db.patient.update({ where: { id: p.id }, data: { clinicId: b.id } })).rejects.toThrow();
      const same = await ctx.db.patient.update({ where: { id: p.id }, data: { firstName: 'Cambio permitido' } });
      expect(same.id).toBe(p.id);
    });
  });

  describe('sin eliminación física', () => {
    it('no se pueden borrar pacientes, identificadores, contactos, representantes, vínculos ni consentimientos', async () => {
      const a = await fx.clinic();
      const p = await patientIn(a.id);
      const ident = await identifier(a.id, p.id, dni());
      const contact = await ctx.db.patientContact.create({ data: { clinicId: a.id, patientId: p.id, type: 'MOBILE', value: '987654321', valueKey: '987654321', createdById: author } });
      const guardian = await ctx.db.guardian.create({ data: { clinicId: a.id, firstName: 'G', lastName: 'R', createdById: author } });
      const link = await ctx.db.patientGuardian.create({ data: { clinicId: a.id, patientId: p.id, guardianId: guardian.id, relationship: 'MOTHER', createdById: author } });
      const consent = await ctx.db.patientConsent.create({
        data: { clinicId: a.id, patientId: p.id, type: 'CLINICAL', documentTitle: 'D', documentVersion: '1', grantedAt: new Date(), grantedBy: 'PATIENT', createdById: author },
      });

      await expect(ctx.db.patientIdentifier.delete({ where: { id: ident.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.patientContact.delete({ where: { id: contact.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.patientGuardian.delete({ where: { id: link.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.guardian.delete({ where: { id: guardian.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.patientConsent.delete({ where: { id: consent.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.patient.delete({ where: { id: p.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.patient.deleteMany({ where: { clinicId: a.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.$executeRaw`DELETE FROM patients WHERE id = ${p.id}`).rejects.toThrow(/eliminación física/);
      expect(await ctx.db.patient.count({ where: { id: p.id } })).toBe(1);
    });

    it('no se puede borrar una clínica con pacientes (FK RESTRICT)', async () => {
      const a = await fx.clinic();
      await patientIn(a.id);
      await expect(ctx.db.clinic.delete({ where: { id: a.id } })).rejects.toThrow();
    });
  });

  describe('aislamiento por clínica (FK compuesta)', () => {
    it('los datos hijos no pueden apuntar a un paciente de otra clínica', async () => {
      const a = await fx.clinic();
      const b = await fx.clinic();
      const p = await patientIn(a.id);
      await expect(identifier(b.id, p.id, dni())).rejects.toThrow();
      await expect(ctx.db.patientContact.create({ data: { clinicId: b.id, patientId: p.id, type: 'MOBILE', value: '1', createdById: author } })).rejects.toThrow();
      await expect(
        ctx.db.patientConsent.create({ data: { clinicId: b.id, patientId: p.id, type: 'CLINICAL', documentTitle: 'D', documentVersion: '1', grantedAt: new Date(), grantedBy: 'PATIENT', createdById: author } }),
      ).rejects.toThrow();
      await expect(
        ctx.db.attachment.create({ data: { clinicId: b.id, patientId: p.id, category: 'OTHER_ADMINISTRATIVE', originalName: 'x', mimeType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64), storageKey: uniq('k'), uploadedById: author } }),
      ).rejects.toThrow();
    });

    it('un representante de otra clínica no puede vincularse a un paciente', async () => {
      const a = await fx.clinic();
      const b = await fx.clinic();
      const p = await patientIn(a.id);
      const foreign = await ctx.db.guardian.create({ data: { clinicId: b.id, firstName: 'G', lastName: 'R', createdById: author } });
      await expect(
        ctx.db.patientGuardian.create({ data: { clinicId: a.id, patientId: p.id, guardianId: foreign.id, relationship: 'MOTHER', createdById: author } }),
      ).rejects.toThrow();
    });
  });

  describe('unicidad de lo vigente', () => {
    it('un mismo documento vigente no puede estar en dos pacientes de la clínica, pero sí en otra clínica o si fue reemplazado', async () => {
      const a = await fx.clinic();
      const b = await fx.clinic();
      const number = dni();
      const p1 = await patientIn(a.id);
      const p2 = await patientIn(a.id);
      await identifier(a.id, p1.id, number);
      await expect(identifier(a.id, p2.id, number)).rejects.toThrow();
      await identifier(b.id, (await patientIn(b.id)).id, number); // otra clínica: válido
      // reemplazado (clave nula) deja libre el documento
      await ctx.db.patientIdentifier.updateMany({ where: { patientId: p1.id }, data: { status: 'SUPERSEDED', activeKey: null, patientTypeKey: null } });
      await identifier(a.id, p2.id, number);
    });

    it('un paciente tiene un solo identificador vigente por tipo', async () => {
      const a = await fx.clinic();
      const p = await patientIn(a.id);
      await identifier(a.id, p.id, dni());
      await expect(identifier(a.id, p.id, dni())).rejects.toThrow();
    });

    it('un solo contacto principal por tipo y paciente, sin repetir el mismo valor vigente', async () => {
      const a = await fx.clinic();
      const p = await patientIn(a.id);
      const contact = (value: string, over: object = {}) =>
        ctx.db.patientContact.create({
          data: { clinicId: a.id, patientId: p.id, type: 'MOBILE', value, valueKey: value, activeKey: `${p.id}|MOBILE|${value}`, createdById: author, ...over },
        });
      await contact('911111111', { isPrimary: true, primaryKey: `${p.id}|MOBILE` });
      await expect(contact('922222222', { isPrimary: true, primaryKey: `${p.id}|MOBILE` })).rejects.toThrow();
      await expect(contact('911111111')).rejects.toThrow();
      await contact('922222222'); // no principal: válido
    });

    it('celular y correo NO son únicos entre pacientes', async () => {
      const a = await fx.clinic();
      const shared = '933333333';
      for (let i = 0; i < 2; i++) {
        const p = await patientIn(a.id);
        await ctx.db.patientContact.create({
          data: { clinicId: a.id, patientId: p.id, type: 'MOBILE', value: shared, valueKey: shared, activeKey: `${p.id}|MOBILE|${shared}`, createdById: author },
        });
      }
      expect(await ctx.db.patientContact.count({ where: { clinicId: a.id, valueKey: shared } })).toBe(2);
    });

    it('un solo consentimiento vigente por tipo y paciente', async () => {
      const a = await fx.clinic();
      const p = await patientIn(a.id);
      const consent = (type: 'CLINICAL' | 'LOYALTY', over: object = {}) =>
        ctx.db.patientConsent.create({
          data: { clinicId: a.id, patientId: p.id, type, documentTitle: 'D', documentVersion: '1', grantedAt: new Date(), grantedBy: 'PATIENT', activeKey: `${p.id}|${type}`, createdById: author, ...over },
        });
      await consent('CLINICAL');
      await expect(consent('CLINICAL')).rejects.toThrow();
      await consent('LOYALTY'); // otro tipo: independiente
      await consent('CLINICAL', { status: 'REVOKED', activeKey: null }); // histórico
    });
  });

  describe('consentimiento como registro inmutable', () => {
    it('el contenido no se edita; solo se revoca, y una revocación no se revierte', async () => {
      const a = await fx.clinic();
      const p = await patientIn(a.id);
      const c = await ctx.db.patientConsent.create({
        data: { clinicId: a.id, patientId: p.id, type: 'MARKETING', documentTitle: 'Original', documentVersion: 'v1', grantedAt: new Date(), grantedBy: 'PATIENT', activeKey: `${p.id}|MARKETING`, createdById: author },
      });
      await expect(ctx.db.patientConsent.update({ where: { id: c.id }, data: { documentVersion: 'v2' } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.patientConsent.update({ where: { id: c.id }, data: { documentTitle: 'Otro' } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.patientConsent.update({ where: { id: c.id }, data: { type: 'CLINICAL' } })).rejects.toThrow(/inmutable/);
      await expect(ctx.db.patientConsent.update({ where: { id: c.id }, data: { grantedAt: new Date(0) } })).rejects.toThrow(/inmutable/);
      await ctx.db.patientConsent.update({ where: { id: c.id }, data: { status: 'REVOKED', activeKey: null, revokedAt: new Date(), revocationReason: 'Motivo' } });
      await expect(ctx.db.patientConsent.update({ where: { id: c.id }, data: { status: 'GRANTED' } })).rejects.toThrow(/no puede reactivarse/);
    });
  });

  describe('auditoría ligada al paciente', () => {
    it('audit_logs conserva patient_id y sigue siendo inmutable', async () => {
      const a = await fx.clinic();
      const p = await patientIn(a.id);
      const row = await ctx.db.auditLog.create({ data: { action: 'T', entity: 'Patient', patientId: p.id, clinicId: a.id } });
      expect((await ctx.db.auditLog.findUniqueOrThrow({ where: { id: row.id } })).patientId).toBe(p.id);
      await expect(ctx.db.auditLog.update({ where: { id: row.id }, data: { patientId: null } })).rejects.toThrow(/inmutable/);
    });
  });
});
