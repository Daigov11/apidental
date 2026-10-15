import { createHash } from 'node:crypto';
import type request from 'supertest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Actor,
  actorIn,
  bearer,
  createPatient,
  createTestContext,
  Fixtures,
  makeJpeg,
  makePdf,
  makePng,
  type TestContext,
  uniq,
} from './helpers/app.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const storageRoot = () => process.env['ATTACHMENTS_DIR']!;
const pathOf = (key: string) => join(storageRoot(), key.slice(0, 2), key);
const filesOnDisk = (): string[] =>
  readdirSync(storageRoot(), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? readdirSync(join(storageRoot(), d.name)) : []));

describe('Adjuntos privados', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());

  async function world() {
    const a = await fx.clinic();
    const b = await fx.clinic();
    const [admin, reception, dentist, assistant, cashier] = (await Promise.all(
      ['CLINIC_ADMIN', 'RECEPTIONIST', 'DENTIST', 'ASSISTANT', 'CASHIER'].map((r) => actorIn(ctx, fx, r, { clinicId: a.id })),
    )) as [Actor, Actor, Actor, Actor, Actor];
    const adminB = await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: b.id });
    const { id: patientId } = await createPatient(ctx, reception.token);
    return { a, b, admin, reception, dentist, assistant, cashier, adminB, patientId };
  }

  const upload = (
    token: string,
    patientId: string,
    file: Buffer | null,
    opts: { name?: string; type?: string; fields?: Record<string, string> } = {},
  ) => {
    let req = ctx.http().post(`/v1/patients/${patientId}/attachments`).set(bearer(token));
    for (const [k, v] of Object.entries({ category: 'OTHER_ADMINISTRATIVE', ...opts.fields })) req = req.field(k, v);
    if (file) req = req.attach('file', file, { filename: opts.name ?? 'doc.pdf', contentType: opts.type ?? 'application/pdf' });
    return req;
  };
  const auditOf = (patientId: string, action: string) => ctx.db.auditLog.findMany({ where: { patientId, action } });

  describe('carga', () => {
    it('guarda el archivo en disco privado con UUID aleatorio, hash SHA-256 y sin exponer rutas', async () => {
      const w = await world();
      const pdf = makePdf();
      const res = await upload(w.reception.token, w.patientId, pdf, { name: 'Consentimiento Firmado.pdf', fields: { description: 'Escaneado' } }).expect(201);

      expect(res.body).toMatchObject({
        category: 'OTHER_ADMINISTRATIVE', originalName: 'Consentimiento Firmado.pdf', mimeType: 'application/pdf',
        sizeBytes: pdf.length, sha256: sha256(pdf), status: 'ACTIVE', description: 'Escaneado', consentId: null,
      });

      // La clave de almacenamiento existe en BD, es un UUID y NO está en la respuesta ni contiene el nombre original
      const row = await ctx.db.attachment.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.storageKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(row.storageKey).not.toContain('Consentimiento');
      const serialized = JSON.stringify(res.body);
      for (const leak of [row.storageKey, storageRoot(), 'storageKey', 'storage_key', '/tmp', 'var/folders']) {
        expect(serialized).not.toContain(leak);
      }

      // En disco: contenido íntegro, permisos 0600, bajo el directorio privado
      expect(readFileSync(pathOf(row.storageKey)).equals(pdf)).toBe(true);
      expect(statSync(pathOf(row.storageKey)).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(storageRoot(), row.storageKey.slice(0, 2)))).toContain(row.storageKey);

      // El contenido NO está en MySQL: la fila solo tiene metadatos
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['data', 'content', 'blob']));
    });

    it('acepta PDF, JPEG, PNG y WebP', async () => {
      const w = await world();
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([9, 0, 0, 0]), Buffer.from(`WEBP${uniq('w')}`)]);
      for (const [file, type] of [[makePdf(), 'application/pdf'], [makeJpeg(), 'image/jpeg'], [makePng(), 'image/png'], [webp, 'image/webp']] as const) {
        const res = await upload(w.reception.token, w.patientId, file, { type, name: 'archivo' }).expect(201);
        expect(res.body.mimeType).toBe(type);
      }
    });

    it('rechaza tipos no permitidos aunque el cliente los declare como válidos (MIME por contenido)', async () => {
      const w = await world();
      const bad: [string, Buffer, string][] = [
        ['ejecutable declarado PDF', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'application/pdf'],
        ['HTML declarado PNG', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
        ['SVG declarado JPEG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/jpeg'],
        ['texto declarado PDF', Buffer.from('hola mundo, esto no es un pdf'), 'application/pdf'],
        ['script declarado imagen', Buffer.from('#!/bin/sh\nrm -rf /\n'), 'image/png'],
        ['ZIP', Buffer.from('PK\x03\x04restoDelZip'), 'application/zip'],
      ];
      const before = filesOnDisk().length;
      for (const [label, file, type] of bad) {
        const res = await upload(w.reception.token, w.patientId, file, { type, name: 'archivo.pdf' });
        expect(res.status, label).toBe(415);
      }
      expect(filesOnDisk().length).toBe(before); // nada llegó a disco
      expect(await ctx.db.attachment.count({ where: { patientId: w.patientId } })).toBe(0);
    });

    it('rechaza cuando el tipo declarado no coincide con el contenido real', async () => {
      const w = await world();
      await upload(w.reception.token, w.patientId, makePng(), { type: 'application/pdf' }).expect(415);
      await upload(w.reception.token, w.patientId, makePdf(), { type: 'image/png' }).expect(415);
      await upload(w.reception.token, w.patientId, makePdf(), { type: 'application/octet-stream' }).expect(415);
    });

    it('valida tamaño: vacío (422) y por encima del máximo configurado (413)', async () => {
      const w = await world();
      await upload(w.reception.token, w.patientId, Buffer.alloc(0)).expect(422);
      const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_048_576 + 10, 0x41)]); // máximo de pruebas: 1 MiB
      const before = filesOnDisk().length;
      await upload(w.reception.token, w.patientId, big).expect(413);
      expect(filesOnDisk().length).toBe(before);
      const edge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_048_576 - 9, 0x41)]);
      expect(edge.length).toBe(1_048_576);
      await upload(w.reception.token, w.patientId, edge).expect(201);
    });

    it('valida el formulario: archivo obligatorio, categoría válida, un solo archivo', async () => {
      const w = await world();
      await upload(w.reception.token, w.patientId, null).expect(400);
      await upload(w.reception.token, w.patientId, makePdf(), { fields: { category: 'RADIOGRAFIA' } }).expect(400);
      await upload(w.reception.token, w.patientId, makePdf(), { fields: { campoExtra: 'x' } }).expect(400);
      await upload(w.reception.token, w.patientId, makePdf(), { fields: { clinicId: w.b.id } }).expect(400);
      await ctx.http().post(`/v1/patients/${w.patientId}/attachments`).set(bearer(w.reception.token)).send({ category: 'CONSENT' }).expect(400);
    });

    it('sanea el nombre original: no se usa como ruta y no permite recorrer directorios', async () => {
      const w = await world();
      const before = filesOnDisk().length;
      const res = await upload(w.reception.token, w.patientId, makePdf(), { name: '../../../etc/passwd.pdf' }).expect(201);
      expect(res.body.originalName).toBe('passwd.pdf');
      expect(filesOnDisk().length).toBe(before + 1);
      // tildes y ñ se conservan íntegras (UTF-8) en el nombre mostrado
      const accents = await upload(w.reception.token, w.patientId, makePdf(), { name: 'Cédula del niño.pdf' }).expect(201);
      expect(accents.body.originalName).toBe('Cédula del niño.pdf');
    });

    it('un archivo idéntico no se carga dos veces para el mismo paciente y categoría', async () => {
      const w = await world();
      const pdf = makePdf();
      await upload(w.reception.token, w.patientId, pdf).expect(201);
      const dup = await upload(w.reception.token, w.patientId, pdf).expect(409);
      expect(dup.body.code).toBe('DUPLICATE_FILE');
      expect(await ctx.db.attachment.count({ where: { patientId: w.patientId } })).toBe(1);
    });

    it('vincula el archivo a un consentimiento del mismo paciente (solo categoría CONSENT)', async () => {
      const w = await world();
      const consent = await ctx.http().post(`/v1/patients/${w.patientId}/consents`).set(bearer(w.reception.token)).send({
        type: 'CLINICAL', documentTitle: 'Consentimiento', documentVersion: 'v1', grantedBy: 'PATIENT',
      }).expect(201);
      const ok = await upload(w.reception.token, w.patientId, makePdf(), { fields: { category: 'CONSENT', consentId: consent.body.id } }).expect(201);
      expect(ok.body).toMatchObject({ category: 'CONSENT', consentId: consent.body.id });
      const list = await ctx.http().get(`/v1/patients/${w.patientId}/consents`).set(bearer(w.admin.token)).expect(200);
      expect(list.body[0].attachmentCount).toBe(1);

      await upload(w.reception.token, w.patientId, makePdf(), { fields: { category: 'IDENTITY_DOCUMENT', consentId: consent.body.id } }).expect(400);
      // consentimiento de OTRO paciente
      const { id: other } = await createPatient(ctx, w.reception.token);
      await upload(w.reception.token, other, makePdf(), { fields: { category: 'CONSENT', consentId: consent.body.id } }).expect(404);
    });

    it('audita la carga con hash y tamaño, nunca con el contenido', async () => {
      const w = await world();
      const pdf = makePdf('contenido-sensible-xyz');
      const res = await upload(w.reception.token, w.patientId, pdf, { name: 'cédula.pdf' }).expect(201);
      const [log] = await auditOf(w.patientId, 'ATTACHMENT_UPLOADED');
      expect(log).toMatchObject({ userId: w.reception.user.id, clinicId: w.a.id, entityId: res.body.id });
      expect(log!.summary).toMatchObject({ category: 'OTHER_ADMINISTRATIVE', mimeType: 'application/pdf', sizeBytes: pdf.length, sha256: sha256(pdf) });
      expect(JSON.stringify(log)).not.toContain('contenido-sensible-xyz');
    });

    it('no se puede cargar en pacientes inactivos ni de otra clínica', async () => {
      const w = await world();
      await upload(w.adminB.token, w.patientId, makePdf()).expect(404);
      await ctx.http().post(`/v1/patients/${w.patientId}/deactivate`).set(bearer(w.admin.token)).send({ reason: 'Paciente inactivo' }).expect(200);
      await upload(w.reception.token, w.patientId, makePdf()).expect(409);
    });
  });

  describe('sin URL pública', () => {
    it('ninguna ruta pública sirve archivos; el único acceso es el endpoint autorizado', async () => {
      const w = await world();
      const res = await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      const row = await ctx.db.attachment.findUniqueOrThrow({ where: { id: res.body.id } });
      const guesses = [
        `/${row.storageKey}`, `/files/${row.storageKey}`, `/storage/${row.storageKey}`, `/uploads/${row.storageKey}`,
        `/v1/files/${row.storageKey}`, `/v1/attachments/${row.id}`, `/v1/patients/${w.patientId}/attachments/${row.id}`,
        `/static/${row.storageKey}`, '/storage/', '/uploads/',
      ];
      for (const path of guesses) {
        const anon = await ctx.http().get(path);
        expect(anon.status, path).not.toBe(200);
        const authed = await ctx.http().get(path).set(bearer(w.admin.token));
        expect(authed.status, `autenticado ${path}`).toBe(404);
      }
    });

    it('el listado y los metadatos jamás incluyen rutas ni claves de almacenamiento', async () => {
      const w = await world();
      const a = await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      const list = await ctx.http().get(`/v1/patients/${w.patientId}/attachments`).set(bearer(w.admin.token)).expect(200);
      const row = await ctx.db.attachment.findUniqueOrThrow({ where: { id: a.body.id } });
      const text = JSON.stringify(list.body);
      expect(text).not.toContain(row.storageKey);
      expect(text).not.toMatch(/storageKey|storage_key|path|clinicId|uploadedById|removedById/);
      expect(list.body[0]).toHaveProperty('sha256');
    });
  });

  describe('descarga autorizada', () => {
    it('devuelve el contenido íntegro con cabeceras seguras y la audita', async () => {
      const w = await world();
      const pdf = makePdf('descarga');
      const up = await upload(w.reception.token, w.patientId, pdf, { name: 'Niño García.pdf' }).expect(201);
      const res = await ctx.http().get(`/v1/patients/${w.patientId}/attachments/${up.body.id}/download`).set(bearer(w.dentist.token)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);

      expect((res.body as Buffer).equals(pdf)).toBe(true);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-length']).toBe(String(pdf.length));
      expect(res.headers['content-disposition']).toBe("attachment; filename=\"Ni_o Garc_a.pdf\"; filename*=UTF-8''Ni%C3%B1o%20Garc%C3%ADa.pdf");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');

      const [log] = await auditOf(w.patientId, 'ATTACHMENT_DOWNLOADED');
      expect(log).toMatchObject({ userId: w.dentist.user.id, clinicId: w.a.id, entityId: up.body.id });
      expect(log!.ip).toBeTruthy();
    });

    it('cada descarga genera su propio registro de auditoría', async () => {
      const w = await world();
      const up = await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      for (const actor of [w.admin, w.reception, w.assistant, w.admin]) {
        await ctx.http().get(`/v1/patients/${w.patientId}/attachments/${up.body.id}/download`).set(bearer(actor.token)).expect(200);
      }
      expect(await auditOf(w.patientId, 'ATTACHMENT_DOWNLOADED')).toHaveLength(4);
    });

    it('se deniega sin JWT, sin permiso, sin contexto, a la plataforma y a otra clínica (sin filtrar datos)', async () => {
      const w = await world();
      const up = await upload(w.reception.token, w.patientId, makePdf('secreto-123')).expect(201);
      const url = `/v1/patients/${w.patientId}/attachments/${up.body.id}/download`;
      const { login, loginInContext } = await import('./helpers/app.js');
      const { user: platform } = await fx.userWithRole('PLATFORM_ADMIN');

      const noContext = await login(ctx, w.admin.user.email);
      const platformToken = await loginInContext(ctx, platform.email);
      // Peticiones perezosas: supertest cierra el servidor al terminar cada una.
      const denied: [string, () => request.Test][] = [
        ['sin JWT', () => ctx.http().get(url)],
        ['token inválido', () => ctx.http().get(url).set('Authorization', 'Bearer basura')],
        ['caja (sin attachment:read)', () => ctx.http().get(url).set(bearer(w.cashier.token))],
        ['sin contexto', () => ctx.http().get(url).set(bearer(noContext))],
        ['plataforma', () => ctx.http().get(url).set(bearer(platformToken))],
        ['otra clínica', () => ctx.http().get(url).set(bearer(w.adminB.token))],
      ];
      const expected = [401, 401, 403, 403, 403, 404];
      for (const [i, [label, send]] of denied.entries()) {
        const res = await send();
        expect(res.status, label).toBe(expected[i]);
        // la respuesta de error no contiene ni el archivo, ni el hash, ni rutas
        const text = JSON.stringify(res.body) + String(res.text ?? '');
        expect(text, label).not.toMatch(/secreto-123|sha256|%PDF|storage/i);
      }
      expect(await auditOf(w.patientId, 'ATTACHMENT_DOWNLOADED')).toHaveLength(0); // ninguna denegación se registra como descarga
    });

    it('un adjunto de otro paciente no se descarga cambiando el patientId de la URL', async () => {
      const w = await world();
      const { id: other } = await createPatient(ctx, w.reception.token);
      const up = await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      await ctx.http().get(`/v1/patients/${other}/attachments/${up.body.id}/download`).set(bearer(w.admin.token)).expect(404);
    });

    it('verifica la integridad: si el archivo en disco fue alterado, no se entrega', async () => {
      const w = await world();
      const up = await upload(w.reception.token, w.patientId, makePdf('integro')).expect(201);
      const row = await ctx.db.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
      writeFileSync(pathOf(row.storageKey), Buffer.from('%PDF-1.4\nCONTENIDO ALTERADO\n'));
      const res = await ctx.http().get(`/v1/patients/${w.patientId}/attachments/${up.body.id}/download`).set(bearer(w.admin.token)).expect(500);
      expect(JSON.stringify(res.body)).not.toMatch(/ALTERADO|storage|sha256/);
    });
  });

  describe('permisos', () => {
    it('administración y recepción cargan; odontólogo y asistente solo leen; caja no accede', async () => {
      const w = await world();
      const seeded = await upload(w.admin.token, w.patientId, makePdf()).expect(201);
      const matrix: [Actor, { upload: number; list: number; remove: number }][] = [
        [w.admin, { upload: 201, list: 200, remove: 200 }],
        [w.reception, { upload: 201, list: 200, remove: 409 }], // 409: ya dado de baja por admin
        [w.dentist, { upload: 403, list: 200, remove: 403 }],
        [w.assistant, { upload: 403, list: 200, remove: 403 }],
        [w.cashier, { upload: 403, list: 403, remove: 403 }],
      ];
      for (const [actor, exp] of matrix) {
        expect((await upload(actor.token, w.patientId, makePdf())).status).toBe(exp.upload);
        expect((await ctx.http().get(`/v1/patients/${w.patientId}/attachments`).set(bearer(actor.token))).status).toBe(exp.list);
        expect((await ctx.http().post(`/v1/patients/${w.patientId}/attachments/${seeded.body.id}/remove`).set(bearer(actor.token)).send({ reason: 'Prueba de permisos' })).status).toBe(exp.remove);
      }
    });
  });

  describe('baja lógica (sin eliminación física)', () => {
    it('exige motivo, conserva el registro y el archivo, y lo deja inaccesible', async () => {
      const w = await world();
      const pdf = makePdf('baja');
      const up = await upload(w.reception.token, w.patientId, pdf).expect(201);
      const row = await ctx.db.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
      const remove = (body: object) => ctx.http().post(`/v1/patients/${w.patientId}/attachments/${up.body.id}/remove`).set(bearer(w.reception.token)).send(body);

      await remove({}).expect(400);
      await remove({ reason: 'x' }).expect(400);
      const res = await remove({ reason: 'Se cargó al paciente equivocado' }).expect(200);
      expect(res.body).toMatchObject({ status: 'REMOVED', removalReason: 'Se cargó al paciente equivocado' });
      await remove({ reason: 'otra vez' }).expect(409);

      // el registro y el archivo físico siguen intactos
      const after = await ctx.db.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
      expect(after).toMatchObject({ status: 'REMOVED', removedById: w.reception.user.id, sha256: sha256(pdf) });
      expect(existsSync(pathOf(row.storageKey))).toBe(true);
      expect(readFileSync(pathOf(row.storageKey)).equals(pdf)).toBe(true);

      // pero ya no se descarga ni aparece en el listado normal
      await ctx.http().get(`/v1/patients/${w.patientId}/attachments/${up.body.id}/download`).set(bearer(w.admin.token)).expect(404);
      const list = await ctx.http().get(`/v1/patients/${w.patientId}/attachments`).set(bearer(w.admin.token)).expect(200);
      expect(list.body).toEqual([]);
      const [log] = await auditOf(w.patientId, 'ATTACHMENT_REMOVED');
      expect(log).toMatchObject({ userId: w.reception.user.id, entityId: up.body.id });
      expect(log!.summary).toMatchObject({ reason: 'Se cargó al paciente equivocado', physicalFileKept: true });
    });

    it('includeRemoved solo lo ven quienes gestionan adjuntos', async () => {
      const w = await world();
      const up = await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      await ctx.http().post(`/v1/patients/${w.patientId}/attachments/${up.body.id}/remove`).set(bearer(w.admin.token)).send({ reason: 'Documento ilegible' }).expect(200);
      const admin = await ctx.http().get(`/v1/patients/${w.patientId}/attachments?includeRemoved=true`).set(bearer(w.admin.token)).expect(200);
      expect(admin.body).toHaveLength(1);
      const dentist = await ctx.http().get(`/v1/patients/${w.patientId}/attachments?includeRemoved=true`).set(bearer(w.dentist.token)).expect(200);
      expect(dentist.body).toEqual([]);
    });

    it('la base de datos impide eliminar adjuntos y alterar su contenido o revertir la baja', async () => {
      const w = await world();
      const up = await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      await expect(ctx.db.attachment.delete({ where: { id: up.body.id } })).rejects.toThrow(/eliminación física/);
      await expect(ctx.db.attachment.update({ where: { id: up.body.id }, data: { sha256: 'a'.repeat(64) } })).rejects.toThrow(/inmutables/);
      await expect(ctx.db.attachment.update({ where: { id: up.body.id }, data: { storageKey: '00000000-0000-0000-0000-000000000000' } })).rejects.toThrow(/inmutables/);
      await ctx.http().post(`/v1/patients/${w.patientId}/attachments/${up.body.id}/remove`).set(bearer(w.admin.token)).send({ reason: 'Prueba de baja' }).expect(200);
      await expect(ctx.db.attachment.update({ where: { id: up.body.id }, data: { status: 'ACTIVE' } })).rejects.toThrow(/no se revierte/);
    });

    it('el servicio no puede borrar archivos: la cantidad en disco nunca disminuye', async () => {
      const w = await world();
      const before = filesOnDisk().length;
      const up = await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      await ctx.http().post(`/v1/patients/${w.patientId}/attachments/${up.body.id}/remove`).set(bearer(w.admin.token)).send({ reason: 'Prueba de no borrado' }).expect(200);
      expect(filesOnDisk().length).toBe(before + 1);
    });
  });

  describe('auditoría de lectura', () => {
    it('listar adjuntos queda registrado con quién y cuántos', async () => {
      const w = await world();
      await upload(w.reception.token, w.patientId, makePdf()).expect(201);
      await ctx.http().get(`/v1/patients/${w.patientId}/attachments`).set(bearer(w.assistant.token)).expect(200);
      const [log] = await auditOf(w.patientId, 'ATTACHMENT_LISTED');
      expect(log).toMatchObject({ userId: w.assistant.user.id, clinicId: w.a.id });
      expect(log!.summary).toEqual({ count: 1, includeRemoved: false });
    });
  });
});
