import { describe, expect, it } from 'vitest';
import { readContent, whatsappNumber } from './site-settings.js';

describe('readContent', () => {
  it('sin datos: textos vacíos y todas las secciones visibles', () => {
    const c = readContent(null);
    expect(c.heroTitle).toBe('');
    expect(c.steps).toEqual([]);
    expect(c.sections).toEqual({ services: true, howItWorks: true, branches: true, faq: true });
  });

  it('ignora datos con forma inválida', () => {
    const c = readContent({ heroTitle: 5, steps: [{ title: 'Uno', text: 'a' }, { title: 2 }, 'x'], faqs: 'no', sections: { faq: false, services: 'no' } });
    expect(c.heroTitle).toBe('');
    expect(c.steps).toEqual([{ title: 'Uno', text: 'a' }]);
    expect(c.faqs).toEqual([]);
    expect(c.sections).toEqual({ services: true, howItWorks: true, branches: true, faq: false });
  });
});

describe('whatsappNumber', () => {
  it('agrega 51 a un celular peruano', () => expect(whatsappNumber('930 607 986')).toBe('51930607986'));
  it('respeta el código de país', () => expect(whatsappNumber('+51 969 874 107')).toBe('51969874107'));
  it('vacío o corto = sin WhatsApp', () => {
    expect(whatsappNumber('')).toBeNull();
    expect(whatsappNumber('12345')).toBeNull();
  });
});
