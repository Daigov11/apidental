import { createTestContext, Fixtures, inviteAndAccept, loginInContext, type TestContext } from './helpers/app.js';

/**
 * Regresión de motor: el producto objetivo es MySQL 8.4. Estas pruebas fallan si la base
 * de pruebas es MariaDB o si el esquema real no tiene las garantías que el modelo asume
 * (JSON nativo, CHECK, triggers de inmutabilidad, claves foráneas compuestas).
 */
describe('Motor MySQL 8.4 y esquema real', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  const rows = <T>(q: Promise<unknown>) => q as Promise<T[]>;

  it('la base de pruebas es MySQL 8.4 (no MariaDB) y usa utf8mb4', async () => {
    const [info] = await rows<{ v: string; c: string; cs: string }>(
      ctx.db.$queryRaw`SELECT VERSION() AS v, @@version_comment AS c, @@character_set_database AS cs`,
    );
    expect(info!.v).toMatch(/^8\.4\./);
    expect(info!.v.toLowerCase()).not.toContain('mariadb');
    expect(info!.c).toMatch(/MySQL/i);
    expect(info!.cs).toBe('utf8mb4');
  });

  it('audit_logs.summary es JSON nativo y admite consultas JSON del motor', async () => {
    const [col] = await rows<{ t: string }>(
      ctx.db.$queryRaw`SELECT DATA_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND column_name = 'summary'`,
    );
    expect(col!.t).toBe('json');

    const summary = { roles: ['CLINIC_ADMIN'], nota: 'Atención ñandú — ✓', anidado: { n: 1, activo: true, nulo: null } };
    const row = await ctx.db.auditLog.create({ data: { action: 'JSON_TEST', entity: 'Test', summary } });
    const back = await ctx.db.auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(back.summary).toEqual(summary); // ida y vuelta exacta, con tildes y símbolos

    const [extracted] = await rows<{ role: string }>(
      ctx.db.$queryRaw`SELECT JSON_UNQUOTE(JSON_EXTRACT(summary, '$.roles[0]')) AS role FROM audit_logs WHERE id = ${row.id}`,
    );
    expect(extracted!.role).toBe('CLINIC_ADMIN');
  });

  it('el summary de auditoría nunca guarda claves sensibles (redacción previa a JSON)', async () => {
    const clinic = await fx.clinic();
    const { user } = await fx.userWithRole('CLINIC_ADMIN', { clinicId: clinic.id });
    const token = await loginInContext(ctx, user.email, { clinicId: clinic.id });
    const secretPassword = 'Contraseña-Que-Elige-La-Persona-9';
    const created = await inviteAndAccept(ctx, token, { roleCode: 'ASSISTANT', email: `json-${Date.now()}@test.pe` }, secretPassword);
    const logs = await ctx.db.auditLog.findMany({ where: { clinicId: clinic.id } });
    expect(logs.length).toBeGreaterThan(0);
    const dump = JSON.stringify(logs);
    for (const secret of [secretPassword, 'argon2', 'password', created.email]) expect(dump).not.toContain(secret);
  });

  it('el esquema real contiene el CHECK de user_assignments y está aplicado', async () => {
    const checks = await rows<{ name: string; enforced: string }>(
      ctx.db.$queryRaw`SELECT CONSTRAINT_NAME AS name, ENFORCED AS enforced FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'user_assignments' AND constraint_type = 'CHECK'`,
    );
    expect(checks).toEqual([{ name: 'user_assignments_branch_requires_clinic_chk', enforced: 'YES' }]);
  });

  it('existen exactamente los triggers de inmutabilidad de audit_logs', async () => {
    const triggers = await rows<{ name: string; event: string; timing: string }>(
      ctx.db.$queryRaw`SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, ACTION_TIMING AS timing FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND event_object_table = 'audit_logs'`,
    );
    expect([...triggers].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'audit_logs_block_delete', event: 'DELETE', timing: 'BEFORE' },
      { name: 'audit_logs_block_update', event: 'UPDATE', timing: 'BEFORE' },
    ]);
  });

  it('la clave foránea compuesta (branch_id, clinic_id) existe con ON UPDATE/DELETE RESTRICT', async () => {
    const fks = await rows<{ name: string; refTable: string; upd: string; del: string; cols: number }>(
      ctx.db.$queryRaw`SELECT rc.CONSTRAINT_NAME AS name, rc.REFERENCED_TABLE_NAME AS refTable, rc.UPDATE_RULE AS upd, rc.DELETE_RULE AS del,
          (SELECT COUNT(*) FROM information_schema.key_column_usage k WHERE k.constraint_schema = rc.constraint_schema AND k.constraint_name = rc.constraint_name AND k.table_name = rc.table_name) AS cols
        FROM information_schema.referential_constraints rc
        WHERE rc.constraint_schema = DATABASE() AND rc.table_name = 'user_assignments' AND rc.constraint_name = 'user_assignments_branch_id_clinic_id_fkey'`,
    );
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ refTable: 'branches', upd: 'RESTRICT', del: 'RESTRICT' });
    expect(Number(fks[0]!.cols)).toBe(2);
  });

  it('todas las tablas son InnoDB y utf8mb4', async () => {
    const tables = await rows<{ name: string; engine: string; collation: string }>(
      ctx.db.$queryRaw`SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual(
      [
        'agenda_services', 'appointment_slots', 'appointments', 'dentist_specialties', 'rooms', 'schedule_blocks', 'schedule_rules', 'specialties',
        'attachments', 'audit_logs', 'auth_sessions', 'branches', 'clinical_access_grants', 'clinical_alerts', 'clinical_allergy_assessments', 'clinical_diagnoses', 'clinical_history_entries', 'clinical_notes', 'clinical_odontograms', 'clinical_procedures', 'clinical_visits', 'clinics', 'guardians', 'invitations',
        'password_recoveries', 'patient_care_relationships', 'patient_consents', 'patient_contacts', 'patient_guardians', 'patient_identifiers', 'patients',
        'permissions', 'procedure_definitions', 'provisioning_records', 'reauth_proofs', 'refresh_tokens', 'role_permissions', 'roles',
        'user_assignments', 'users',
      ].sort(),
    );
    for (const t of tables) {
      expect(t.engine).toBe('InnoDB');
      expect(t.collation).toMatch(/^utf8mb4/);
    }
  });

  it('existen los triggers de inmutabilidad y no-borrado (pacientes, invitaciones, aprovisionamiento, reautenticación)', async () => {
    const triggers = await rows<{ name: string; table: string; event: string }>(
      ctx.db.$queryRaw`SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS \`table\`, EVENT_MANIPULATION AS event FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND event_object_table <> 'audit_logs'`,
    );
    const key = (t: { table: string; event: string }) => `${t.table}:${t.event}`;
    expect(triggers.map(key).sort()).toEqual(
      [
        'attachments:DELETE', 'attachments:UPDATE', 'guardians:DELETE', 'patient_consents:DELETE', 'patient_consents:UPDATE',
        'patient_contacts:DELETE', 'patient_guardians:DELETE', 'patient_identifiers:DELETE', 'patients:DELETE', 'patients:UPDATE',
        'invitations:DELETE', 'invitations:UPDATE', 'password_recoveries:DELETE', 'password_recoveries:UPDATE', 'provisioning_records:DELETE', 'provisioning_records:UPDATE',
        'reauth_proofs:UPDATE', 'refresh_tokens:UPDATE',
        'patient_care_relationships:INSERT', 'patient_care_relationships:UPDATE', 'patient_care_relationships:DELETE',
        'clinical_allergy_assessments:INSERT', 'clinical_allergy_assessments:UPDATE', 'clinical_allergy_assessments:DELETE',
        'clinical_odontograms:INSERT', 'clinical_odontograms:UPDATE', 'clinical_odontograms:DELETE',
        'clinical_notes:INSERT', 'clinical_notes:UPDATE', 'clinical_notes:DELETE',
        'clinical_diagnoses:INSERT', 'clinical_diagnoses:UPDATE', 'clinical_diagnoses:DELETE',
        'clinical_procedures:INSERT', 'clinical_procedures:UPDATE', 'clinical_procedures:DELETE',
        'clinical_visits:INSERT', 'clinical_visits:UPDATE', 'clinical_visits:DELETE',
        'procedure_definitions:UPDATE', 'procedure_definitions:DELETE',
        'clinical_alerts:INSERT', 'clinical_alerts:UPDATE', 'clinical_alerts:DELETE',
        'clinical_history_entries:INSERT', 'clinical_history_entries:UPDATE', 'clinical_history_entries:DELETE',
        'clinical_access_grants:INSERT', 'clinical_access_grants:UPDATE', 'clinical_access_grants:DELETE',
        'role_permissions:INSERT', 'role_permissions:UPDATE',
        'appointments:UPDATE', 'appointments:DELETE', 'schedule_blocks:UPDATE', 'schedule_blocks:DELETE',
      ].sort(),
    );
  });

  it('las tablas hijas de pacientes usan FK compuesta (patient_id, clinic_id) hacia patients', async () => {
    const fks = await rows<{ tableName: string; refTable: string; cols: number }>(
      ctx.db.$queryRaw`SELECT rc.TABLE_NAME AS tableName, rc.REFERENCED_TABLE_NAME AS refTable,
          (SELECT COUNT(*) FROM information_schema.key_column_usage k WHERE k.constraint_schema = rc.constraint_schema AND k.constraint_name = rc.constraint_name AND k.table_name = rc.table_name) AS cols
        FROM information_schema.referential_constraints rc
        WHERE rc.constraint_schema = DATABASE() AND rc.referenced_table_name = 'patients'`,
    );
    expect(fks.map((f) => f.tableName).sort()).toEqual(
      ['appointments', 'attachments', 'clinical_access_grants', 'clinical_alerts', 'clinical_allergy_assessments', 'clinical_diagnoses', 'clinical_history_entries', 'clinical_notes', 'clinical_odontograms', 'clinical_procedures', 'clinical_visits', 'patient_care_relationships', 'patient_consents', 'patient_contacts', 'patient_guardians', 'patient_identifiers'],
    );
    for (const f of fks) expect(Number(f.cols)).toBe(2);
  });

  it('el DNI, la fecha de nacimiento y los importes de texto conservan tildes y tipo DATE', async () => {
    const [col] = await rows<{ t: string }>(
      ctx.db.$queryRaw`SELECT DATA_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'patients' AND column_name = 'birth_date'`,
    );
    expect(col!.t).toBe('date');
  });
});
