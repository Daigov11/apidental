import { sanitizeFileName, sniffMime } from './file-sniff.js';

describe('sniffMime (por contenido)', () => {
  it('reconoce PDF, JPEG, PNG y WebP por su firma', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
  });

  it('rechaza ejecutables, HTML, SVG, ZIP y archivos vacíos o truncados', () => {
    for (const bad of [
      Buffer.from('MZ\x90\x00'),
      Buffer.from('<html><script>alert(1)</script>'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from('PK\x03\x04'),
      Buffer.from('#!/bin/sh\nrm -rf /'),
      Buffer.alloc(0),
      Buffer.from('%PD'),
    ]) {
      expect(sniffMime(bad)).toBeNull();
    }
  });
});

describe('sanitizeFileName', () => {
  it('elimina rutas, caracteres de control y puntos iniciales', () => {
    expect(sanitizeFileName('../../etc/passwd.pdf')).toBe('passwd.pdf');
    expect(sanitizeFileName('C:\\Users\\x\\consentimiento.pdf')).toBe('consentimiento.pdf');
    expect(sanitizeFileName('.hidden.pdf')).toBe('hidden.pdf');
    expect(sanitizeFileName('a\u0000b\r\nc.pdf')).toBe('abc.pdf');
    expect(sanitizeFileName('')).toBe('archivo');
    expect(sanitizeFileName('..')).toBe('archivo');
  });

  it('acota la longitud y conserva tildes', () => {
    expect(sanitizeFileName(`${'a'.repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
    expect(sanitizeFileName('Consentimiento niño.pdf')).toBe('Consentimiento niño.pdf');
  });
});
