import { splitPersonName } from './person-name.js';

describe('splitPersonName', () => {
  it('toma los dos últimos términos como apellidos', () => {
    expect(splitPersonName('DIEGO ALBERTO MENDIETA HUAROTO')).toEqual({ firstName: 'DIEGO ALBERTO', lastName: 'MENDIETA', secondLastName: 'HUAROTO' });
    expect(splitPersonName('  ROBERTO   CARLOS ESPINAR VICHARRA ')).toEqual({ firstName: 'ROBERTO CARLOS', lastName: 'ESPINAR', secondLastName: 'VICHARRA' });
  });
  it('usa los nombres informados para repartir el resto como apellidos', () => {
    expect(splitPersonName('MARIA DEL CARMEN DE LA CRUZ LOPEZ', 'MARIA DEL CARMEN')).toEqual({ firstName: 'MARIA DEL CARMEN', lastName: 'DE', secondLastName: 'LA CRUZ LOPEZ' });
    expect(splitPersonName('JUAN PEREZ GOMEZ', 'Juan')).toEqual({ firstName: 'Juan', lastName: 'PEREZ', secondLastName: 'GOMEZ' });
  });
  it('maneja nombres cortos y vacíos', () => {
    expect(splitPersonName('ANA PEREZ')).toEqual({ firstName: 'ANA', lastName: 'PEREZ', secondLastName: '' });
    expect(splitPersonName('ANA')).toEqual({ firstName: 'ANA', lastName: '', secondLastName: '' });
    expect(splitPersonName('')).toEqual({ firstName: '', lastName: '', secondLastName: '' });
  });
});
