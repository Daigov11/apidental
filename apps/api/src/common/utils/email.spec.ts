import { canonicalEmailIdentity } from './email.js';

describe('canonicalEmailIdentity', () => {
  it('ignora mayúsculas, espacios y la etiqueta +algo', () => {
    expect(canonicalEmailIdentity('  Ana.Perez+clinica@Empresa.pe ')).toBe(
      'ana.perez@empresa.pe',
    );
    expect(canonicalEmailIdentity('ana.perez@empresa.pe')).toBe(
      canonicalEmailIdentity('ANA.PEREZ+x+y@EMPRESA.PE'),
    );
  });

  it('en Gmail ignora además los puntos y unifica googlemail.com', () => {
    expect(canonicalEmailIdentity('j.o.s.e@gmail.com')).toBe('jose@gmail.com');
    expect(canonicalEmailIdentity('jose+a@googlemail.com')).toBe(
      'jose@gmail.com',
    );
  });

  it('fuera de Gmail los puntos SÍ distinguen cuentas, y los dominios distintos son distintos', () => {
    expect(canonicalEmailIdentity('a.b@empresa.pe')).not.toBe(
      canonicalEmailIdentity('ab@empresa.pe'),
    );
    expect(canonicalEmailIdentity('ana@empresa.pe')).not.toBe(
      canonicalEmailIdentity('ana@otra.pe'),
    );
  });
});
