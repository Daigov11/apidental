import { phoneLabelOf, readMessageId, toRecipient } from './apiworking-whatsapp.service.js';

describe('WhatsApp por el centralizador (reglas de la guía)', () => {
  it('destinatario con «+» y código de país (+51 para un celular peruano)', () => {
    expect(toRecipient('987654321')).toBe('+51987654321');
    expect(toRecipient('987 654 321')).toBe('+51987654321');
    expect(toRecipient('+51 987-654-321')).toBe('+51987654321');
    expect(toRecipient('+34 612 345 678')).toBe('+34612345678');
    expect(toRecipient('1234')).toBeNull();
  });

  it('etiqueta del teléfono: dominio del idSistema con los puntos cambiados por «_»', () => {
    expect(phoneLabelOf('https://logisticagroinversionesedrick.apiworking.co/')).toBe('logisticagroinversionesedrick_apiworking_co');
    expect(phoneLabelOf('https://tiendaglowsmile.apiworking.co/')).toBe('tiendaglowsmile_apiworking_co');
  });

  it('id del mensaje: message_id, messageId o id (también dentro de data)', () => {
    expect(readMessageId({ message_id: 'wamid.1' })).toBe('wamid.1');
    expect(readMessageId({ messageId: 'm-2' })).toBe('m-2');
    expect(readMessageId({ id: 33 })).toBe('33');
    expect(readMessageId({ success: true, data: { message_id: 'x9' } })).toBe('x9');
    expect(readMessageId({ success: true })).toBeNull();
  });
});
