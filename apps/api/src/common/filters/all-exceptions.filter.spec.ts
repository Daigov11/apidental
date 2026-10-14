import { BadRequestException, ForbiddenException, Logger, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function run(exception: unknown) {
  const json = vi.fn();
  const res = { status: vi.fn().mockReturnValue({ json }) };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ path: '/v1/x', requestId: 'rid-12345' }) }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: res.status.mock.calls[0]![0] as number, body: json.mock.calls[0]![0] };
}

describe('AllExceptionsFilter', () => {
  it('formatea errores HTTP de forma consistente', () => {
    const { status, body } = run(new ForbiddenException('No permitido'));
    expect(status).toBe(403);
    expect(body).toMatchObject({ statusCode: 403, error: 'Acceso denegado', message: 'No permitido', path: '/v1/x', requestId: 'rid-12345' });
    expect(body.timestamp).toBeTruthy();
  });

  it('conserva los mensajes de validación como lista', () => {
    const { body } = run(new BadRequestException(['email inválido', 'password corto']));
    expect(body.message).toEqual(['email inválido', 'password corto']);
  });

  it('en errores no controlados oculta el detalle interno', () => {
    Logger.overrideLogger(false);
    const { status, body } = run(new Error('SELECT * FROM users WHERE password=secreto'));
    expect(status).toBe(500);
    expect(body.message).toBe('Error interno del servidor');
    expect(JSON.stringify(body)).not.toContain('secreto');
  });
});
