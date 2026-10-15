#!/usr/bin/env node
// Receptor LOCAL de desarrollo para probar el canal "webhook" (invitaciones y recuperación de contraseña).
// Verifica la firma HMAC y la antigüedad, e imprime el enlace por consola. NO es un servicio de envío:
// en producción su sistema receptor debe hacer estas mismas verificaciones y entregar el mensaje.
//
//   INVITATION_WEBHOOK_SECRET=<el mismo de la API> node scripts/dev-webhook-receiver.mjs [puerto=4010]
//   (en la API: INVITATION_DELIVERY_MODE=webhook INVITATION_WEBHOOK_URL=http://127.0.0.1:4010/hook)
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const secret = process.env.INVITATION_WEBHOOK_SECRET;
if (!secret || secret.length < 32) {
  console.error('Defina INVITATION_WEBHOOK_SECRET (>= 32 caracteres), el mismo que usa la API.');
  process.exit(1);
}
const port = Number(process.argv[2] ?? 4010);
const MAX_AGE_SECONDS = 300;

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const timestamp = String(req.headers['x-apidental-timestamp'] ?? '');
    const given = String(req.headers['x-apidental-signature'] ?? '');
    const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
    const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= MAX_AGE_SECONDS;
    if (req.method !== 'POST' || !ok || !fresh) {
      console.error('Rechazado: firma o marca de tiempo inválida');
      res.writeHead(401).end();
      return;
    }
    const event = JSON.parse(body);
    console.log(`[${new Date().toISOString()}] ${event.event}`);
    console.log(JSON.stringify(event, null, 2));
    res.writeHead(204).end();
  });
}).listen(port, '127.0.0.1', () => console.log(`Receptor de desarrollo escuchando en http://127.0.0.1:${port}`));
