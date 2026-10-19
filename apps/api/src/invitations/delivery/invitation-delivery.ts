import { createHmac } from 'node:crypto';
import type { AppConfig } from '../../config/app-config.js';

export const INVITATION_DELIVERY = Symbol('INVITATION_DELIVERY');

export interface InvitationMessage {
  type: 'invitation';
  invitationId: string;
  toEmail: string;
  /** Enlace de aceptación. El token va en el FRAGMENTO (#token=…): no llega a servidores, proxies ni registros de acceso. */
  acceptUrl: string;
  clinicName: string | null;
  roleName: string;
  expiresAt: Date;
}

export interface PasswordRecoveryMessage {
  type: 'password_recovery';
  recoveryId: string;
  toEmail: string;
  /** Enlace de restablecimiento; el token va en el fragmento (#token=…). */
  resetUrl: string;
  expiresAt: Date;
}

/** Receta en PDF para el correo del paciente. El contenido viaja como adjunto; no se registra en ningún log. */
export interface PrescriptionMessage {
  type: 'prescription';
  prescriptionId: string;
  toEmail: string;
  patientName: string;
  clinicName: string;
  /** Correlativo visible (RX-000001). */
  number: string;
  fileName: string;
  pdf: Buffer;
}

/** Todo lo que sale hacia el canal configurado (el mismo adaptador firmado sirve a todos los flujos). */
export type DeliveryMessage = InvitationMessage | PasswordRecoveryMessage | PrescriptionMessage;

/** `reason` es siempre un código genérico y saneado: nunca la URL, el token ni la respuesta del canal. */
export type DeliveryOutcome = { ok: true; devLink?: string } | { ok: false; reason: string };

/** Canal de entrega de enlaces. No asume proveedor de correo: el operador lo conecta como quiera. */
export interface InvitationDelivery {
  readonly mode: 'dev' | 'webhook' | 'disabled';
  deliver(message: DeliveryMessage): Promise<DeliveryOutcome>;
}

/**
 * SOLO desarrollo y pruebas (la configuración lo prohíbe en producción).
 *  - Invitación: devuelve el enlace en la respuesta del que invita (persona autorizada).
 *  - Recuperación de contraseña: la respuesta es neutral y NO puede llevar el enlace; queda en un
 *    buzón EN MEMORIA que las pruebas leen (nunca se escribe en logs). Para desarrollo manual,
 *    use el canal webhook con `scripts/dev-webhook-receiver.mjs`.
 */
export class DevDelivery implements InvitationDelivery {
  readonly mode = 'dev' as const;
  /** Últimos mensajes entregados (acotado). */
  readonly outbox: { type: DeliveryMessage['type']; to: string; url: string; at: Date }[] = [];

  async deliver(message: DeliveryMessage): Promise<DeliveryOutcome> {
    const url = message.type === 'invitation' ? message.acceptUrl : message.type === 'password_recovery' ? message.resetUrl : '';
    this.outbox.push({ type: message.type, to: message.toEmail, url, at: new Date() });
    if (this.outbox.length > 200) this.outbox.shift();
    return message.type === 'invitation' ? { ok: true, devLink: url } : { ok: true };
  }

  /** Último mensaje de un tipo para un destinatario (solo para pruebas). */
  last(type: DeliveryMessage['type'], to: string) {
    return [...this.outbox].reverse().find((m) => m.type === type && m.to === to);
  }
}

/** Sin canal configurado (valor por defecto en producción): nada se entrega y la creación falla cerrada. */
export class DisabledDelivery implements InvitationDelivery {
  readonly mode = 'disabled' as const;
  async deliver(_message?: DeliveryMessage): Promise<DeliveryOutcome> {
    return { ok: false, reason: 'disabled' };
  }
}

function webhookPayload(message: DeliveryMessage) {
  if (message.type === 'invitation') {
    return {
      event: 'invitation.deliver',
      invitationId: message.invitationId,
      to: message.toEmail,
      acceptUrl: message.acceptUrl,
      clinicName: message.clinicName,
      roleName: message.roleName,
      expiresAt: message.expiresAt.toISOString(),
    };
  }
  if (message.type === 'password_recovery') {
    return {
      event: 'password_recovery.deliver',
      recoveryId: message.recoveryId,
      to: message.toEmail,
      resetUrl: message.resetUrl,
      expiresAt: message.expiresAt.toISOString(),
    };
  }
  return {
    event: 'prescription.deliver',
    prescriptionId: message.prescriptionId,
    to: message.toEmail,
    patientName: message.patientName,
    clinicName: message.clinicName,
    number: message.number,
    attachment: { fileName: message.fileName, contentType: 'application/pdf', contentBase64: message.pdf.toString('base64') },
  };
}

/**
 * POST firmado al sistema de envío que el operador configure (correo, SMS, cola interna…).
 * Firma: HMAC-SHA256 de `${timestamp}.${cuerpo}` en `X-ApiDental-Signature: sha256=<hex>`, con
 * `X-ApiDental-Timestamp` (segundos) para que el receptor rechace repeticiones. Sin redirecciones,
 * con tiempo límite, y sin registrar jamás la URL, el cuerpo ni la respuesta.
 */
export class WebhookDelivery implements InvitationDelivery {
  readonly mode = 'webhook' as const;
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs = 5_000,
  ) {}

  static sign(secret: string, timestamp: string, body: string): string {
    return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  }

  async deliver(message: DeliveryMessage): Promise<DeliveryOutcome> {
    const body = JSON.stringify(webhookPayload(message));
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-apidental-timestamp': timestamp,
          'x-apidental-signature': WebhookDelivery.sign(this.secret, timestamp, body),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(message.type === 'prescription' ? this.timeoutMs * 3 : this.timeoutMs),
      });
      return res.ok ? { ok: true } : { ok: false, reason: `http_${res.status}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  }
}

export function createDelivery(config: AppConfig): InvitationDelivery {
  const { mode, webhookUrl, webhookSecret } = config.invitations;
  if (mode === 'dev') return new DevDelivery();
  if (mode === 'webhook' && webhookUrl && webhookSecret) return new WebhookDelivery(webhookUrl, webhookSecret);
  return new DisabledDelivery();
}
