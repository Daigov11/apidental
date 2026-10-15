import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebhookDelivery } from '../src/invitations/delivery/invitation-delivery.js';
import {
  acceptReq,
  actorIn,
  bearer,
  createTestContext,
  Fixtures,
  inviteReq,
  tokenFromUrl,
  type TestContext,
  uniq,
} from './helpers/app.js';

const SECRET = 'webhook-secret-'.padEnd(40, 'k');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
  json: Record<string, string>;
}

// Receptor local que simula el sistema de envío que configure el operador.
let server: Server;
let port = 0;
let received: Received[] = [];
let behavior: 'ok' | 'fail500' | 'redirect' | 'slow' = 'ok';
let redirectedHits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/elsewhere') {
      redirectedHits += 1;
      res.writeHead(200).end('ok');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      received.push({ headers: req.headers, body, json: JSON.parse(body || '{}') });
      if (behavior === 'fail500') return void res.writeHead(500).end('error interno con datos: secreto-del-receptor');
      if (behavior === 'redirect') return void res.writeHead(302, { Location: `http://127.0.0.1:${port}/elsewhere` }).end();
      if (behavior === 'slow') return void setTimeout(() => res.writeHead(200).end('ok'), 800);
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  process.env['INVITATION_DELIVERY_MODE'] = 'webhook';
  process.env['INVITATION_WEBHOOK_URL'] = `http://127.0.0.1:${port}/hook`;
  process.env['INVITATION_WEBHOOK_SECRET'] = SECRET;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Canal de entrega webhook firmado (sin asumir proveedor de correo)', () => {
  let ctx: TestContext;
  let fx: Fixtures;
  beforeAll(async () => {
    ctx = await createTestContext();
    fx = new Fixtures(ctx.db);
  });
  afterAll(() => ctx.close());
  beforeEach(() => {
    received = [];
    behavior = 'ok';
    redirectedHits = 0;
  });

  async function admin() {
    const clinic = await fx.clinic();
    return { clinic, actor: await actorIn(ctx, fx, 'CLINIC_ADMIN', { clinicId: clinic.id }) };
  }

  it('entrega el enlace SOLO al canal: firmado, con el destinatario, y nunca en la respuesta, la BD ni la auditoría', async () => {
    const { clinic, actor } = await admin();
    const to = `${uniq('wh')}@test.pe`;
    const res = await inviteReq(ctx, actor.token, { email: to, roleCode: 'DENTIST' }).expect(201);

    expect(res.body.devAcceptUrl).toBeUndefined();
    expect(res.body.delivery).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(received).toHaveLength(1);
    const hit = received[0]!;
    expect(hit.json).toMatchObject({ event: 'invitation.deliver', invitationId: res.body.id, to, clinicName: clinic.name, roleName: 'Odontólogo' });
    expect(hit.json['acceptUrl']).toMatch(/^http:\/\/localhost:5173\/admin\/aceptar-invitacion#token=inv_[A-Za-z0-9_-]{43}$/);

    // firma HMAC válida y marca de tiempo reciente (para que el receptor rechace repeticiones)
    const ts = hit.headers['x-apidental-timestamp'] as string;
    expect(Math.abs(Date.now() / 1000 - Number(ts))).toBeLessThan(10);
    expect(hit.headers['x-apidental-signature']).toBe(WebhookDelivery.sign(SECRET, ts, hit.body));
    expect(WebhookDelivery.sign('otro-secreto'.padEnd(32, 'x'), ts, hit.body)).not.toBe(hit.headers['x-apidental-signature']);
    expect(WebhookDelivery.sign(SECRET, ts, hit.body + ' ')).not.toBe(hit.headers['x-apidental-signature']);
    expect(hit.headers['content-type']).toBe('application/json');

    // el token entregado funciona, y no está en ningún otro lugar
    const token = tokenFromUrl(hit.json['acceptUrl']!);
    const row = await ctx.db.invitation.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.tokenHash).toBe(sha(token)); // en la BD solo el hash...
    expect(JSON.stringify(row)).not.toContain(token); // ...nunca el token en claro
    // ni la respuesta ni la auditoría contienen el token, su hash, el secreto del canal ni su dirección
    const exposed = JSON.stringify(res.body) + JSON.stringify(await ctx.db.auditLog.findMany({ where: { clinicId: clinic.id } }));
    for (const secret of [token, sha(token), SECRET, `127.0.0.1:${port}`]) expect(exposed).not.toContain(secret);
    await acceptReq(ctx, token).expect(200);
  });

  it('si el canal falla, la invitación queda FAILED con un motivo genérico (sin URL ni respuesta del canal) y se audita', async () => {
    const { clinic, actor } = await admin();
    behavior = 'fail500';
    const res = await inviteReq(ctx, actor.token, { email: `${uniq('wh')}@test.pe`, roleCode: 'DENTIST' }).expect(201);
    expect(res.body.delivery).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'http_500' });
    expect(res.body.devAcceptUrl).toBeUndefined();
    const [log] = await ctx.db.auditLog.findMany({ where: { entityId: res.body.id, action: 'INVITATION_DELIVERY_FAILED' } });
    expect(log!.summary).toMatchObject({ channel: 'webhook', kind: 'created', reason: 'http_500' });
    const dump = JSON.stringify(res.body) + JSON.stringify(await ctx.db.auditLog.findMany({ where: { clinicId: clinic.id } }));
    for (const leak of ['secreto-del-receptor', SECRET, `127.0.0.1:${port}`, '/hook']) expect(dump).not.toContain(leak);

    // reenviar con el canal ya sano: token nuevo, entrega correcta y el listado muestra el estado
    behavior = 'ok';
    const resent = await ctx.http().post(`/v1/invitations/${res.body.id}/resend`).set(bearer(actor.token)).send({}).expect(200);
    expect(resent.body.delivery).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    const token = tokenFromUrl(received.at(-1)!.json['acceptUrl']!);
    await acceptReq(ctx, token).expect(200);
  });

  it('no sigue redirecciones: un 302 se trata como fallo y no se contacta el otro destino', async () => {
    const { actor } = await admin();
    behavior = 'redirect';
    const res = await inviteReq(ctx, actor.token, { email: `${uniq('wh')}@test.pe`, roleCode: 'DENTIST' }).expect(201);
    expect(res.body.delivery).toMatchObject({ status: 'FAILED', lastError: 'network' });
    expect(redirectedHits).toBe(0);
  });

  it('el reenvío rota el token: el enlace entregado la primera vez deja de servir', async () => {
    const { actor } = await admin();
    const res = await inviteReq(ctx, actor.token, { email: `${uniq('wh')}@test.pe`, roleCode: 'ASSISTANT' }).expect(201);
    const first = tokenFromUrl(received[0]!.json['acceptUrl']!);
    await ctx.http().post(`/v1/invitations/${res.body.id}/resend`).set(bearer(actor.token)).send({}).expect(200);
    const second = tokenFromUrl(received[1]!.json['acceptUrl']!);
    expect(second).not.toBe(first);
    await acceptReq(ctx, first).expect(404);
    await acceptReq(ctx, second).expect(200);
  });

  describe('WebhookDelivery (unidad)', () => {
    const message = { invitationId: 'i', toEmail: 'a@b.pe', acceptUrl: 'http://x/#token=inv_x', clinicName: null, roleName: 'Rol', expiresAt: new Date() };

    it('un receptor lento produce un fallo "timeout" (tiempo límite acotado)', async () => {
      behavior = 'slow';
      const out = await new WebhookDelivery(`http://127.0.0.1:${port}/hook`, SECRET, 100).deliver(message);
      expect(out).toEqual({ ok: false, reason: 'timeout' });
    });

    it('un receptor inalcanzable produce "network", sin exponer la dirección', async () => {
      const out = await new WebhookDelivery('http://127.0.0.1:1/hook', SECRET, 500).deliver(message);
      expect(out).toEqual({ ok: false, reason: 'network' });
    });

    it('un 2xx es éxito y cualquier otro código se informa solo como http_<código>', async () => {
      expect(await new WebhookDelivery(`http://127.0.0.1:${port}/hook`, SECRET).deliver(message)).toEqual({ ok: true });
      behavior = 'fail500';
      expect(await new WebhookDelivery(`http://127.0.0.1:${port}/hook`, SECRET).deliver(message)).toEqual({ ok: false, reason: 'http_500' });
    });
  });
});
