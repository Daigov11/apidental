import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AccessService } from '../src/auth/access.service.js';
import type { AuthPrincipal } from '../src/auth/auth.types.js';
import { ClinicalAccessService } from '../src/clinical/clinical-access.service.js';
import { ClinicalAccessDeniedException } from '../src/clinical/clinical.errors.js';
import {
  actorIn,
  assignCare,
  bearer,
  clinicalConsentBody,
  createPatient,
  createTestContext,
  Fixtures,
  grantReadAll,
  login,
  loginInContext,
  reauthProofFor,
  requestReadAllReq,
  revokeCareReq,
  sessionIdOf,
  summaryReq,
  type TestContext,
  uniq,
} from './helpers/app.js';

const GHOST = '8e5f2c5a-7d3e-4f52-9d7c-3b7a1e9d6c11';
const expectStatus = <T extends { status: number; body: unknown }>(
  res: T,
  status: number,
): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
};

describe('Acceso clínico: relación asistencial, vista de apoyo y lectura excepcional', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());
  afterEach(() => vi.restoreAllMocks());

  async function world() {
    const clinic = await fx.clinic();
    const branchA = await fx.branch(clinic.id);
    const branchB = await fx.branch(clinic.id);
    const admin = await actorIn(ctx, fx, 'CLINIC_ADMIN', {
      clinicId: clinic.id,
    });
    const reception = await actorIn(ctx, fx, 'RECEPTIONIST', {
      clinicId: clinic.id,
    });
    const cashier = await actorIn(ctx, fx, 'CASHIER', { clinicId: clinic.id });
    const dentist = await actorIn(ctx, fx, 'DENTIST', { clinicId: clinic.id });
    const director = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', {
      clinicId: clinic.id,
    });
    const { id: patientId } = await createPatient(ctx, reception.token, {
      lastName: uniq('Paciente'),
    });
    return {
      clinic,
      branchA,
      branchB,
      admin,
      reception,
      cashier,
      dentist,
      director,
      patientId,
    };
  }
  const denials = (userId: string, where: object = {}) =>
    ctx.db.auditLog.findMany({
      where: { userId, action: 'CLINICAL_ACCESS_DENIED', ...where },
      orderBy: { createdAt: 'asc' },
    });
  const audits = (patientId: string, action: string) =>
    ctx.db.auditLog.findMany({ where: { patientId, action } });

  async function principalOf(
    userId: string,
    context: { clinicId: string; branchId: string | null },
    sessionId = 'sesion-de-prueba',
  ): Promise<AuthPrincipal> {
    const access = await ctx.app.get(AccessService).resolve(userId, context);
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      sessionId,
      context,
      roles: access!.roles,
      permissions: access!.permissions,
    };
  }
  const meta = { ip: '10.0.0.9', userAgent: 'vitest' };

  describe('odontólogo', () => {
    it('con relación asistencial lee el resumen clínico: nivel FULL, auditado con paciente, IP y secciones', async () => {
      const w = await world();
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      const res = await summaryReq(ctx, w.dentist.token, w.patientId).expect(
        200,
      );
      expect(res.body.access).toEqual({
        level: 'FULL',
        via: 'care_relationship',
        readOnly: false,
      });
      expect(res.body.patient).toMatchObject({
        id: w.patientId,
        status: 'ACTIVE',
      });
      expect(res.body.sections).toMatchObject({ status: 'NOT_AVAILABLE' });
      expect(res.body.alerts).toEqual([
        expect.objectContaining({
          code: 'CLINICAL_CONSENT_MISSING',
          severity: 'WARNING',
        }),
      ]);
      expect(res.body.clinicalConsent).toMatchObject({ state: 'MISSING' });

      const [log] = await audits(w.patientId, 'CLINICAL_RECORD_VIEWED');
      expect(log).toMatchObject({
        userId: w.dentist.user.id,
        clinicId: w.clinic.id,
        entity: 'Patient',
      });
      expect(log!.ip).toBeTruthy();
      expect(log!.summary).toMatchObject({
        level: 'FULL',
        via: 'care_relationship',
        intent: 'read',
        sections: ['summary'],
      });
      // la auditoría no copia datos personales ni clínicos
      expect(JSON.stringify(log)).not.toMatch(
        new RegExp(String(res.body.patient.fullName).split(' ').at(-1)!),
      );
    });

    it('sin relación: 403 NO_CARE_RELATIONSHIP, auditado como denegado con el paciente (y sin duplicar ACCESS_DENIED)', async () => {
      const w = await world();
      const denied = await summaryReq(ctx, w.dentist.token, w.patientId).expect(
        403,
      );
      expect(denied.body).toMatchObject({ code: 'NO_CARE_RELATIONSHIP' });
      const [log] = await denials(w.dentist.user.id);
      expect(log).toMatchObject({
        patientId: w.patientId,
        clinicId: w.clinic.id,
      });
      expect(log!.summary).toMatchObject({
        intent: 'read',
        reason: 'no_care_relationship',
        roles: ['DENTIST'],
      });
      expect(
        await ctx.db.auditLog.count({
          where: { userId: w.dentist.user.id, action: 'ACCESS_DENIED' },
        }),
      ).toBe(0);
      expect(await audits(w.patientId, 'CLINICAL_RECORD_VIEWED')).toHaveLength(
        0,
      );
    });

    it('la relación de OTRO odontólogo no le sirve', async () => {
      const w = await world();
      const colleague = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, colleague.user.id);
      await summaryReq(ctx, w.dentist.token, w.patientId).expect(403);
    });

    it('lee a un paciente que atendió en otra sede de la misma clínica mientras siga asignado a la clínica', async () => {
      const w = await world();
      const d = await fx.user();
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, d.id, {
        branchId: w.branchB.id,
      }); // se atendió en la sede B
      const inA = await loginInContext(ctx, d.email, {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const inB = await loginInContext(ctx, d.email, {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      await summaryReq(ctx, inA, w.patientId).expect(200); // continuidad asistencial: otra sede
      await summaryReq(ctx, inB, w.patientId).expect(200);
      // si deja de estar asignado a la clínica, ya no
      await ctx.db.userAssignment.updateMany({
        where: { userId: d.id },
        data: { status: 'INACTIVE' },
      });
      await ctx.http().get('/v1/auth/me').set(bearer(inA)).expect(403);
      await summaryReq(ctx, inA, w.patientId).expect(403);
    });

    it('escritura: exige la sede de origen de la relación (lectura no); una relación de toda la clínica sirve en cualquier sede', async () => {
      const w = await world();
      const d = await fx.user();
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      await fx.assign(d.id, 'DENTIST', {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, d.id, {
        branchId: w.branchB.id,
      });
      const service = ctx.app.get(ClinicalAccessService);
      const inA = await principalOf(d.id, {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const inB = await principalOf(d.id, {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      expect(
        (await service.authorize(inA, w.patientId, 'read', ['summary'], meta))
          .level,
      ).toBe('FULL');
      await expect(
        service.authorize(inA, w.patientId, 'write', ['note'], meta),
      ).rejects.toMatchObject({ denialCode: 'WRONG_BRANCH' });
      expect(
        (await service.authorize(inB, w.patientId, 'write', ['note'], meta))
          .level,
      ).toBe('FULL');
      expect(
        (await audits(w.patientId, 'CLINICAL_WRITE_AUTHORIZED')).length,
      ).toBe(1);

      // relación de toda la clínica: cualquier sede
      const p2 = (await createPatient(ctx, w.reception.token)).id;
      await assignCare(ctx, w.reception.token, p2, d.id);
      expect(
        (await service.authorize(inA, p2, 'write', ['note'], meta)).level,
      ).toBe('FULL');
      // contexto sin sede (asignación por sede): la escritura de una relación con sede exige elegirla
      const clinicWide = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      const p3 = (await createPatient(ctx, w.reception.token)).id;
      await assignCare(ctx, w.reception.token, p3, clinicWide.user.id, {
        branchId: w.branchA.id,
      });
      const noBranch = await principalOf(clinicWide.user.id, {
        clinicId: w.clinic.id,
        branchId: null,
      });
      await expect(
        service.authorize(noBranch, p3, 'write', ['note'], meta),
      ).rejects.toMatchObject({ denialCode: 'WRONG_BRANCH' });
      expect(
        (await service.authorize(noBranch, p3, 'read', ['summary'], meta))
          .level,
      ).toBe('FULL');
    });

    it('no puede escribir sin relación ni sin el permiso (asistente y Director no escriben)', async () => {
      const w = await world();
      const service = ctx.app.get(ClinicalAccessService);
      const dentist = await principalOf(w.dentist.user.id, {
        clinicId: w.clinic.id,
        branchId: null,
      });
      await expect(
        service.authorize(dentist, w.patientId, 'write', ['note'], meta),
      ).rejects.toMatchObject({ denialCode: 'NO_CARE_RELATIONSHIP' });
      const assistant = await fx.userWithRole('ASSISTANT', {
        clinicId: w.clinic.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      await expect(
        service.authorize(
          await principalOf(assistant.user.id, {
            clinicId: w.clinic.id,
            branchId: null,
          }),
          w.patientId,
          'write',
          ['note'],
          meta,
        ),
      ).rejects.toMatchObject({ denialCode: 'CLINICAL_PERMISSION_REQUIRED' });
      await expect(
        service.authorize(
          await principalOf(w.director.user.id, {
            clinicId: w.clinic.id,
            branchId: null,
          }),
          w.patientId,
          'write',
          ['note'],
          meta,
        ),
      ).rejects.toBeInstanceOf(ClinicalAccessDeniedException);
    });
  });

  describe('asistente: vista de apoyo', () => {
    it('ve solo alertas y datos de apoyo de pacientes en atención en su sede; nada de datos clínicos ni demográficos extra', async () => {
      const w = await world();
      const assistant = await actorIn(ctx, fx, 'ASSISTANT', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const dentist = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, dentist.user.id, {
        branchId: w.branchA.id,
      });
      const res = await summaryReq(ctx, assistant.token, w.patientId).expect(
        200,
      );
      expect(Object.keys(res.body).sort()).toEqual(['access', 'alerts', 'clinicalAlerts', 'patient', 'supportData']);
      expect(res.body.access).toEqual({
        level: 'LIMITED',
        via: 'support_view',
        readOnly: true,
      });
      expect(Object.keys(res.body.patient).sort()).toEqual([
        'age',
        'fullName',
        'id',
        'isMinor',
      ]);
      expect(res.body.supportData).toEqual({ clinicalConsent: 'MISSING' });
      expect(res.body.alerts[0]).toMatchObject({
        code: 'CLINICAL_CONSENT_MISSING',
      });
      expect(res.body).not.toHaveProperty('sections');
      const [log] = await audits(w.patientId, 'CLINICAL_RECORD_VIEWED');
      expect(log!.summary).toMatchObject({
        level: 'LIMITED',
        via: 'support_view',
      });
    });

    it('sin relación vigente en su sede no ve nada; la relación de otra sede no sirve; el contexto de toda la clínica sí', async () => {
      const w = await world();
      const inA = await actorIn(ctx, fx, 'ASSISTANT', {
        clinicId: w.clinic.id,
        branchId: w.branchA.id,
      });
      const inB = await actorIn(ctx, fx, 'ASSISTANT', {
        clinicId: w.clinic.id,
        branchId: w.branchB.id,
      });
      const wide = await actorIn(ctx, fx, 'ASSISTANT', {
        clinicId: w.clinic.id,
      });
      const dentist = await fx.userWithRole('DENTIST', {
        clinicId: w.clinic.id,
      });
      await summaryReq(ctx, inA.token, w.patientId).expect(403); // aún sin relación
      await assignCare(ctx, w.reception.token, w.patientId, dentist.user.id, {
        branchId: w.branchA.id,
      });
      await summaryReq(ctx, inA.token, w.patientId).expect(200);
      const denied = await summaryReq(ctx, inB.token, w.patientId).expect(403);
      expect(denied.body.code).toBe('NO_CARE_RELATIONSHIP');
      await summaryReq(ctx, wide.token, w.patientId).expect(200);
      // una relación de toda la clínica cubre todas las sedes
      const p2 = (await createPatient(ctx, w.reception.token)).id;
      await assignCare(ctx, w.reception.token, p2, dentist.user.id);
      await summaryReq(ctx, inB.token, p2).expect(200);
    });

    it('nunca escribe: la lectura limitada no autoriza escritura', async () => {
      const w = await world();
      const assistant = await fx.userWithRole('ASSISTANT', {
        clinicId: w.clinic.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      const p = await principalOf(assistant.user.id, {
        clinicId: w.clinic.id,
        branchId: null,
      });
      await expect(
        ctx.app
          .get(ClinicalAccessService)
          .authorize(p, w.patientId, 'write', ['note'], meta),
      ).rejects.toMatchObject({ denialCode: 'CLINICAL_PERMISSION_REQUIRED' });
    });
  });

  describe('sin acceso clínico por defecto', () => {
    it('plataforma, administración y caja: 403 genérico, sea el paciente real o inexistente (recepción solo lee: ver reception-view)', async () => {
      const w = await world();
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      const { user } = await fx.userWithRole('PLATFORM_ADMIN');
      const platformToken = await loginInContext(ctx, user.email);
      const platformInClinic = await login(ctx, user.email); // sin contexto
      for (const token of [
        platformToken,
        platformInClinic,
        w.admin.token,
        w.cashier.token,
      ]) {
        const real = await summaryReq(ctx, token, w.patientId).expect(403);
        const ghost = await summaryReq(ctx, token, GHOST).expect(403);
        expect(real.body.message).toBe(ghost.body.message); // indistinguibles
        await requestReadAllReq(ctx, token, w.patientId, {
          category: 'OTHER',
          reason: 'Intento sin permiso',
          reauthToken: 'x'.repeat(20),
        }).expect(403);
      }
      expect(await audits(w.patientId, 'CLINICAL_RECORD_VIEWED')).toHaveLength(
        0,
      );
      expect(
        await audits(w.patientId, 'CLINICAL_READ_ALL_GRANTED'),
      ).toHaveLength(0);
      // Recepción solo tiene vista de lectura: no puede pedir la lectura excepcional del Director
      await requestReadAllReq(ctx, w.reception.token, w.patientId, {
        category: 'OTHER',
        reason: 'Intento sin permiso',
        reauthToken: 'x'.repeat(20),
      }).expect(403);
    });

    it('el administrador que además es odontólogo (otorgado por otro) tampoco lee sin relación ni se la asigna', async () => {
      const w = await world();
      const both = await fx.user();
      await fx.assign(both.id, 'CLINIC_ADMIN', { clinicId: w.clinic.id });
      await fx.assign(
        both.id,
        'DENTIST',
        { clinicId: w.clinic.id },
        w.admin.user.id,
      );
      const token = await loginInContext(ctx, both.email, {
        clinicId: w.clinic.id,
      });
      await summaryReq(ctx, token, w.patientId).expect(403);
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/care-relationships`)
        .set(bearer(token))
        .send({ dentistUserId: both.id })
        .expect(403);
      await summaryReq(ctx, token, w.patientId).expect(403);
      await assignCare(ctx, w.reception.token, w.patientId, both.id); // otra persona sí puede
      await summaryReq(ctx, token, w.patientId).expect(200);
    });
  });

  describe('aislamiento entre clínicas y enumeración', () => {
    it('un paciente de otra clínica responde 404 idéntico al inexistente y no se registra su id', async () => {
      const w = await world();
      const other = await fx.clinic();
      const dentistB = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: other.id,
      });
      const directorB = await actorIn(ctx, fx, 'CLINICAL_DIRECTOR', {
        clinicId: other.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      for (const token of [dentistB.token, directorB.token]) {
        const foreign = await summaryReq(ctx, token, w.patientId).expect(404);
        const ghost = await summaryReq(ctx, token, GHOST).expect(404);
        expect(foreign.body.message).toBe(ghost.body.message);
      }
      // pedir la autorización read_all de un paciente ajeno tampoco revela nada
      const proof = await reauthProofFor(
        ctx,
        directorB.token,
        'CLINICAL_READ_ALL',
        w.patientId,
      );
      const foreignGrant = await requestReadAllReq(
        ctx,
        directorB.token,
        w.patientId,
        {
          category: 'OTHER',
          reason: 'Quiero verlo sin permiso',
          reauthToken: proof,
        },
      ).expect(404);
      const proof2 = await reauthProofFor(
        ctx,
        directorB.token,
        'CLINICAL_READ_ALL',
        GHOST,
      );
      const ghostGrant = await requestReadAllReq(ctx, directorB.token, GHOST, {
        category: 'OTHER',
        reason: 'Quiero verlo sin permiso',
        reauthToken: proof2,
      }).expect(404);
      expect(foreignGrant.body.message).toBe(ghostGrant.body.message);
      expect(
        await ctx.db.clinicalAccessGrant.count({
          where: { userId: directorB.user.id },
        }),
      ).toBe(0);
      // lo registrado no contiene el id ajeno ni asocia el paciente ajeno al usuario
      const rows = await ctx.db.auditLog.findMany({
        where: {
          userId: { in: [dentistB.user.id, directorB.user.id] },
          action: 'CLINICAL_ACCESS_DENIED',
        },
      });
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const r of rows) {
        expect(r.patientId).toBeNull();
        expect(r.entityId).toBeNull();
        expect(r.clinicId).toBe(other.id);
        expect(r.summary).toMatchObject({ reason: 'patient_unavailable' });
        expect(JSON.stringify(r)).not.toContain(w.patientId);
      }
    });

    it('enumeración: ids inexistentes y de otra clínica se ven igual (404); sin permiso clínico, 403 uniforme; recepción lee el paciente propio', async () => {
      const w = await world();
      const other = await fx.clinic();
      const dentistB = await actorIn(ctx, fx, 'DENTIST', {
        clinicId: other.id,
      });
      const { id: foreignPatient } = await createPatient(
        ctx,
        (await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: w.clinic.id }))
          .token,
      );
      const probes = [
        GHOST,
        ...Array.from({ length: 12 }, () => crypto.randomUUID()),
        foreignPatient,
      ];
      const bodies = new Set<string>();
      for (const id of probes)
        bodies.add(
          JSON.stringify(
            (await summaryReq(ctx, dentistB.token, id).expect(404)).body
              .message,
          ),
        );
      expect(bodies.size).toBe(1);
      // el recepcionista (solo lectura) ve lo mismo para un id inexistente y uno de otra clínica; el propio sí lo lee
      const msgs = new Set<string>();
      const otherReception = await actorIn(ctx, fx, 'RECEPTIONIST', { clinicId: other.id });
      const { id: patientOfOtherClinic } = await createPatient(ctx, otherReception.token);
      for (const id of [GHOST, patientOfOtherClinic])
        msgs.add(
          (await summaryReq(ctx, w.reception.token, id).expect(404)).body
            .message,
        );
      expect(msgs.size).toBe(1);
      await summaryReq(ctx, w.reception.token, w.patientId).expect(200);
      // administración y caja (sin permiso clínico): 403 igual para cualquier id
      const denied = new Set<string>();
      for (const id of [GHOST, foreignPatient, w.patientId])
        denied.add(
          (await summaryReq(ctx, w.admin.token, id).expect(403)).body.message,
        );
      expect(denied.size).toBe(1);
      // la búsqueda demográfica sigue limitada a la clínica
      const search = await ctx
        .http()
        .get('/v1/patients?name=Paciente')
        .set(bearer(dentistB.token))
        .expect(200);
      expect(JSON.stringify(search.body)).not.toContain(w.patientId);
    });
  });

  describe('consentimiento clínico: alerta, no bloqueo', () => {
    it('la falta de consentimiento genera alerta en la ficha y el resumen; registrarlo la quita; revocarlo cambia la alerta; nada bloquea', async () => {
      const w = await world();
      const dentist = w.dentist;
      await assignCare(ctx, w.reception.token, w.patientId, dentist.user.id);
      // crear paciente y trabajar con él sigue permitido sin consentimiento
      const created = await ctx
        .http()
        .post('/v1/patients')
        .set(bearer(w.reception.token))
        .send({ firstName: 'Nuevo', lastName: uniq('Sin') })
        .expect(201);
      expect(created.body.warnings).toContain('CLINICAL_CONSENT_MISSING');
      const ficha = await ctx
        .http()
        .get(`/v1/patients/${w.patientId}`)
        .set(bearer(w.admin.token))
        .expect(200);
      expect(ficha.body.warnings).toContain('CLINICAL_CONSENT_MISSING');
      expect(
        (await summaryReq(ctx, dentist.token, w.patientId).expect(200)).body
          .alerts[0].code,
      ).toBe('CLINICAL_CONSENT_MISSING');

      const consent = await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/consents`)
        .set(bearer(w.reception.token))
        .send(clinicalConsentBody())
        .expect(201);
      const ok = await summaryReq(ctx, dentist.token, w.patientId).expect(200);
      expect(ok.body.alerts).toEqual([]);
      expect(ok.body.clinicalConsent.state).toBe('GRANTED');
      expect(
        (
          await ctx
            .http()
            .get(`/v1/patients/${w.patientId}`)
            .set(bearer(w.admin.token))
            .expect(200)
        ).body.warnings,
      ).not.toContain('CLINICAL_CONSENT_MISSING');

      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/consents/${consent.body.id}/revoke`)
        .set(bearer(w.reception.token))
        .send({ reason: 'El paciente lo retiró' })
        .expect(200);
      expect(
        (await summaryReq(ctx, dentist.token, w.patientId).expect(200)).body
          .alerts[0].code,
      ).toBe('CLINICAL_CONSENT_REVOKED');
    });
  });

  describe('Director Clínico: lectura excepcional (clinical:read_all)', () => {
    it('sin autorización no lee: 403 CLINICAL_JUSTIFICATION_REQUIRED, auditado', async () => {
      const w = await world();
      const res = await summaryReq(ctx, w.director.token, w.patientId).expect(
        403,
      );
      expect(res.body).toMatchObject({
        code: 'CLINICAL_JUSTIFICATION_REQUIRED',
      });
      const [log] = await denials(w.director.user.id);
      expect(log).toMatchObject({ patientId: w.patientId });
      expect(log!.summary).toMatchObject({ reason: 'justification_required' });
    });

    it('con reautenticación y justificación: autoriza 30 minutos a UN paciente, solo lectura, auditado con categoría, motivo e IP', async () => {
      const w = await world();
      const reason = 'Revisión de calidad de un reclamo recibido';
      const res = expectStatus(
        await grantReadAll(ctx, w.director.token, w.patientId, {
          category: 'QUALITY_AUDIT',
          reason,
        }),
        201,
      );
      expect(res.body).toMatchObject({
        patientId: w.patientId,
        category: 'QUALITY_AUDIT',
        expiresInSeconds: 1800,
        scope: 'single_patient',
        readOnly: true,
      });
      const minutes =
        (new Date(res.body.expiresAt).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(29);
      expect(minutes).toBeLessThanOrEqual(30);

      const [granted] = await audits(w.patientId, 'CLINICAL_READ_ALL_GRANTED');
      expect(granted).toMatchObject({
        userId: w.director.user.id,
        clinicId: w.clinic.id,
      });
      expect(granted!.ip).toBeTruthy();
      expect(
        granted!.userAgent === null || typeof granted!.userAgent === 'string',
      ).toBe(true);
      expect(granted!.summary).toMatchObject({
        grantId: res.body.grantId,
        category: 'QUALITY_AUDIT',
        reason,
        minutes: 30,
      });

      const read = await summaryReq(ctx, w.director.token, w.patientId).expect(
        200,
      );
      expect(read.body.access).toMatchObject({
        level: 'READ_ALL',
        via: 'read_all_grant',
        readOnly: true,
        grant: { id: res.body.grantId },
      });
      expect(read.body.sections).toMatchObject({ status: 'NOT_AVAILABLE' });
      await summaryReq(ctx, w.director.token, w.patientId).expect(200);
      const reads = await audits(w.patientId, 'CLINICAL_READ_ALL_READ');
      expect(reads).toHaveLength(2); // cada lectura posterior también se audita
      expect(reads[0]!.summary).toMatchObject({
        level: 'READ_ALL',
        via: 'read_all_grant',
        grantId: res.body.grantId,
        category: 'QUALITY_AUDIT',
        sections: ['summary'],
      });
      expect(await audits(w.patientId, 'CLINICAL_RECORD_VIEWED')).toHaveLength(
        0,
      );
    });

    it('sin reautenticación válida no hay autorización: falta, inválida, vencida, usada o para otro propósito', async () => {
      const w = await world();
      const body = {
        category: 'CONTINUITY_OF_CARE',
        reason: 'Continuidad de la atención',
      };
      await requestReadAllReq(ctx, w.director.token, w.patientId, body).expect(
        400,
      ); // sin prueba
      const bad = await requestReadAllReq(ctx, w.director.token, w.patientId, {
        ...body,
        reauthToken: 'rp_' + 'A'.repeat(43),
      }).expect(403);
      expect(bad.body.code).toBe('REAUTHENTICATION_REQUIRED');
      const wrongPurpose = await reauthProofFor(
        ctx,
        w.director.token,
        'CLOSE_CLINICAL_NOTE',
        w.patientId,
      );
      await requestReadAllReq(ctx, w.director.token, w.patientId, {
        ...body,
        reauthToken: wrongPurpose,
      }).expect(403);
      // vencida: se inserta una prueba ya vencida (la tabla solo permite marcar una prueba como usada)
      const expired = 'rp_' + 'B'.repeat(43);
      await ctx.db.reauthProof.create({
        data: {
          userId: w.director.user.id,
          sessionId: sessionIdOf(w.director.token),
          purpose: 'CLINICAL_READ_ALL',
          targetId: w.patientId,
          tokenHash: createHash('sha256').update(expired).digest('hex'),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      await requestReadAllReq(ctx, w.director.token, w.patientId, {
        ...body,
        reauthToken: expired,
      }).expect(403);
      expect(
        await ctx.db.clinicalAccessGrant.count({
          where: { userId: w.director.user.id },
        }),
      ).toBe(0);
      expect(
        (await audits(w.patientId, 'CLINICAL_ACCESS_DENIED')).filter(
          (l) =>
            (l.summary as { reason: string }).reason ===
            'reauthentication_failed',
        ).length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        await ctx.db.auditLog.count({
          where: { userId: w.director.user.id, action: 'REAUTH_REJECTED' },
        }),
      ).toBeGreaterThanOrEqual(3);
    });

    it('la prueba de reautenticación no se reutiliza ni sirve para otro paciente', async () => {
      const w = await world();
      const p2 = (await createPatient(ctx, w.reception.token)).id;
      const body = {
        category: 'CONTINUITY_OF_CARE',
        reason: 'Continuidad de la atención',
      };
      const proof = await reauthProofFor(
        ctx,
        w.director.token,
        'CLINICAL_READ_ALL',
        w.patientId,
      );
      await requestReadAllReq(ctx, w.director.token, w.patientId, {
        ...body,
        reauthToken: proof,
      }).expect(201);
      await requestReadAllReq(ctx, w.director.token, w.patientId, {
        ...body,
        reauthToken: proof,
      }).expect(403); // reutilizada
      await requestReadAllReq(ctx, w.director.token, p2, {
        ...body,
        reauthToken: await reauthProofFor(
          ctx,
          w.director.token,
          'CLINICAL_READ_ALL',
          w.patientId,
        ),
      }).expect(403); // paciente distinto
      await requestReadAllReq(ctx, w.director.token, p2, {
        ...body,
        reauthToken: await reauthProofFor(
          ctx,
          w.director.token,
          'CLINICAL_READ_ALL',
        ),
      }).expect(403); // sin paciente
      expect(
        await ctx.db.clinicalAccessGrant.count({
          where: { userId: w.director.user.id },
        }),
      ).toBe(1);
      const rejected = await ctx.db.auditLog.findMany({
        where: { userId: w.director.user.id, action: 'REAUTH_REJECTED' },
      });
      expect(
        rejected
          .map((r) => (r.summary as { reason: string }).reason)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(['already_used', 'other_target', 'other_target']);
    });

    it('justificación inválida: categoría desconocida, motivo corto o solo espacios', async () => {
      const w = await world();
      for (const over of [
        { category: 'CURIOSIDAD' },
        { reason: 'corto' },
        { reason: '         x         ' },
        { reason: ' '.repeat(40) },
        { reason: 'a'.repeat(501) },
      ]) {
        expectStatus(
          await grantReadAll(ctx, w.director.token, w.patientId, over),
          400,
        );
      }
      expect(
        await ctx.db.clinicalAccessGrant.count({
          where: { userId: w.director.user.id },
        }),
      ).toBe(0);
    });

    it('la autorización no sirve para otro paciente, otra sesión ni vencida; la base impone el tope de 30 minutos', async () => {
      const w = await world();
      const p2 = (await createPatient(ctx, w.reception.token)).id;
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      await summaryReq(ctx, w.director.token, w.patientId).expect(200);
      expect(
        (await summaryReq(ctx, w.director.token, p2).expect(403)).body.code,
      ).toBe('CLINICAL_JUSTIFICATION_REQUIRED'); // otro paciente

      // otra sesión del mismo Director
      const other = await loginInContext(ctx, w.director.user.email, {
        clinicId: w.clinic.id,
      });
      expect(sessionIdOf(other)).not.toBe(sessionIdOf(w.director.token));
      expect(
        (await summaryReq(ctx, other, w.patientId).expect(403)).body.code,
      ).toBe('CLINICAL_JUSTIFICATION_REQUIRED');

      // vencida: se inserta una autorización ya vencida (granted_at en el pasado)
      const past = new Date(Date.now() - 3 * 3_600_000);
      await ctx.db.clinicalAccessGrant.create({
        data: {
          clinicId: w.clinic.id,
          patientId: p2,
          userId: w.director.user.id,
          sessionId: sessionIdOf(w.director.token),
          category: 'OTHER',
          reason: 'Autorización de prueba vencida',
          grantedAt: past,
          expiresAt: new Date(past.getTime() + 30 * 60_000),
        },
      });
      await summaryReq(ctx, w.director.token, p2).expect(403);

      // tope de 30 minutos y justificación mínima impuestos por la base de datos; inmutable
      const base = {
        clinicId: w.clinic.id,
        patientId: p2,
        userId: w.director.user.id,
        sessionId: 'x',
        category: 'OTHER' as const,
      };
      await expect(
        ctx.db.clinicalAccessGrant.create({
          data: {
            ...base,
            reason: 'Justificación suficiente',
            expiresAt: new Date(Date.now() + 31 * 60_000),
          },
        }),
      ).rejects.toThrow(/30 minutos/);
      await expect(
        ctx.db.clinicalAccessGrant.create({
          data: {
            ...base,
            reason: 'corto',
            expiresAt: new Date(Date.now() + 10 * 60_000),
          },
        }),
      ).rejects.toThrow(/10 caracteres/);
      const row = await ctx.db.clinicalAccessGrant.findFirstOrThrow({
        where: { patientId: w.patientId },
      });
      await expect(
        ctx.db.clinicalAccessGrant.update({
          where: { id: row.id },
          data: { reason: 'Cambiada a posteriori' },
        }),
      ).rejects.toThrow(/inmutables/);
      await expect(
        ctx.db.clinicalAccessGrant.delete({ where: { id: row.id } }),
      ).rejects.toThrow(/no se eliminan/);
    });

    it('cerrar la sesión invalida la autorización; no escribe; y no equivale a relación asistencial', async () => {
      const w = await world();
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      await summaryReq(ctx, w.director.token, w.patientId).expect(200);
      await ctx
        .http()
        .post('/v1/auth/logout')
        .set(bearer(w.director.token))
        .set({
          Origin: 'http://localhost:5173',
          'X-Requested-With': 'ApiDental',
          'Content-Type': 'application/json',
        })
        .send('{}');
      await summaryReq(ctx, w.director.token, w.patientId).expect(401);

      // el Director no recibe nivel FULL ni puede escribir aunque tenga autorización
      const w2 = await world();
      expectStatus(
        await grantReadAll(ctx, w2.director.token, w2.patientId),
        201,
      );
      const sid = sessionIdOf(w2.director.token);
      const p = await principalOf(
        w2.director.user.id,
        { clinicId: w2.clinic.id, branchId: null },
        sid,
      );
      const service = ctx.app.get(ClinicalAccessService);
      await expect(
        service.authorize(p, w2.patientId, 'write', ['note'], meta),
      ).rejects.toMatchObject({ denialCode: 'CLINICAL_PERMISSION_REQUIRED' });
      expect(
        (await service.authorize(p, w2.patientId, 'read', ['summary'], meta))
          .level,
      ).toBe('READ_ALL');
    });

    it('la auditoría y las tablas clínicas no guardan la prueba de reautenticación, la contraseña ni datos del paciente', async () => {
      const w = await world();
      const proof = await reauthProofFor(
        ctx,
        w.director.token,
        'CLINICAL_READ_ALL',
        w.patientId,
      );
      await requestReadAllReq(ctx, w.director.token, w.patientId, {
        category: 'LEGAL_REQUEST',
        reason: 'Requerimiento legal recibido por la clínica',
        reauthToken: proof,
      }).expect(201);
      await summaryReq(ctx, w.director.token, w.patientId).expect(200);
      const patient = await ctx.db.patient.findUniqueOrThrow({
        where: { id: w.patientId },
      });
      const dump = JSON.stringify([
        await ctx.db.auditLog.findMany({
          where: {
            OR: [{ userId: w.director.user.id }, { patientId: w.patientId }],
          },
        }),
        await ctx.db.clinicalAccessGrant.findMany({
          where: { patientId: w.patientId },
        }),
      ]);
      for (const secret of [
        proof,
        createHash('sha256').update(proof).digest('hex'),
        'Clave-De-Prueba-123',
        patient.lastName,
      ])
        expect(dump).not.toContain(secret);
      expect(dump).not.toMatch(/\brp_[A-Za-z0-9_-]{43}\b/);
    });

    it('un administrador no obtiene read_all: ni por la ruta ni asignándose el rol de Director', async () => {
      const w = await world();
      await ctx
        .http()
        .post(`/v1/patients/${w.patientId}/clinical-access`)
        .set(bearer(w.admin.token))
        .send({
          category: 'OTHER',
          reason: 'Quiero leer la historia',
          reauthToken: 'x'.repeat(20),
        })
        .expect(403);
      const res = await ctx
        .http()
        .post('/v1/assignments')
        .set(bearer(w.admin.token))
        .send({ userId: w.admin.user.id, roleCode: 'CLINICAL_DIRECTOR' })
        .expect(403);
      expect(res.body.message).toBeDefined();
      await summaryReq(ctx, w.admin.token, w.patientId).expect(403);
    });

    it('el permiso read_all solo puede estar en el rol Director: la base de datos lo impide en cualquier otro', async () => {
      const dentist = await ctx.db.role.findUniqueOrThrow({
        where: { code: 'DENTIST' },
      });
      const perm = await ctx.db.permission.findUniqueOrThrow({
        where: { code: 'clinical:read_all' },
      });
      await expect(
        ctx.db.rolePermission.create({
          data: { roleId: dentist.id, permissionId: perm.id },
        }),
      ).rejects.toThrow(/solo puede asignarse al rol CLINICAL_DIRECTOR/);
      const holders = await ctx.db.rolePermission.findMany({
        where: { permissionId: perm.id },
        include: { role: true },
      });
      expect(holders.map((h) => h.role.code)).toEqual(['CLINICAL_DIRECTOR']);
    });
  });

  describe('falla cerrada: la auditoría va ANTES de entregar el dato', () => {
    function failAudit(action: string) {
      const audit = ctx.app.get(AuditService);
      const original = audit.record.bind(audit);
      return vi.spyOn(audit, 'record').mockImplementation(async (entry, tx) => {
        if (entry.action === action)
          throw new Error('Auditoría no disponible (prueba)');
        return original(entry, tx);
      });
    }

    it('si falla la auditoría de la lectura del odontólogo: 503 y no se entrega ningún dato', async () => {
      const w = await world();
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      failAudit('CLINICAL_RECORD_VIEWED');
      const res = await summaryReq(ctx, w.dentist.token, w.patientId).expect(
        503,
      );
      expect(JSON.stringify(res.body)).not.toMatch(
        /fullName|birthDate|alerts|sections|patient"/,
      );
      expect(await audits(w.patientId, 'CLINICAL_RECORD_VIEWED')).toHaveLength(
        0,
      );
      vi.restoreAllMocks();
      await summaryReq(ctx, w.dentist.token, w.patientId).expect(200);
    });

    it('si falla la auditoría de la vista de apoyo del asistente o de la lectura read_all: 503', async () => {
      const w = await world();
      const assistant = await actorIn(ctx, fx, 'ASSISTANT', {
        clinicId: w.clinic.id,
      });
      await assignCare(ctx, w.reception.token, w.patientId, w.dentist.user.id);
      expectStatus(await grantReadAll(ctx, w.director.token, w.patientId), 201);
      failAudit('CLINICAL_RECORD_VIEWED');
      const a = await summaryReq(ctx, assistant.token, w.patientId).expect(503);
      expect(a.body).not.toHaveProperty('patient');
      vi.restoreAllMocks();
      failAudit('CLINICAL_READ_ALL_READ');
      const d = await summaryReq(ctx, w.director.token, w.patientId).expect(
        503,
      );
      expect(d.body).not.toHaveProperty('patient');
      expect(await audits(w.patientId, 'CLINICAL_READ_ALL_READ')).toHaveLength(
        0,
      );
    });

    it('si falla la auditoría de la autorización read_all: no se crea la autorización ni se gasta la prueba', async () => {
      const w = await world();
      const proof = await reauthProofFor(
        ctx,
        w.director.token,
        'CLINICAL_READ_ALL',
        w.patientId,
      );
      failAudit('CLINICAL_READ_ALL_GRANTED');
      const body = {
        category: 'CONTINUITY_OF_CARE',
        reason: 'Continuidad de la atención',
        reauthToken: proof,
      };
      await requestReadAllReq(ctx, w.director.token, w.patientId, body).expect(
        503,
      );
      expect(
        await ctx.db.clinicalAccessGrant.count({
          where: { userId: w.director.user.id },
        }),
      ).toBe(0);
      vi.restoreAllMocks();
      // la prueba no se consumió (la transacción se revirtió) y sigue sirviendo
      await requestReadAllReq(ctx, w.director.token, w.patientId, body).expect(
        201,
      );
    });
  });

  describe('revocación y acceso inmediato', () => {
    it('revocar la relación corta el acceso de inmediato; el Director conserva su vía excepcional', async () => {
      const w = await world();
      const rel = await assignCare(
        ctx,
        w.reception.token,
        w.patientId,
        w.dentist.user.id,
      );
      await summaryReq(ctx, w.dentist.token, w.patientId).expect(200);
      await revokeCareReq(ctx, w.admin.token, rel.id).expect(200);
      await summaryReq(ctx, w.dentist.token, w.patientId).expect(403);
      const denied = await denials(w.dentist.user.id);
      expect(denied.at(-1)!.summary).toMatchObject({
        reason: 'no_care_relationship',
      });
    });
  });
});
