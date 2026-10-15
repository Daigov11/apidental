import { BadRequestException, ForbiddenException, Logger, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

type Audit = { recordSafely: ReturnType<typeof vi.fn> };
function build() {
  const audit: Audit = { recordSafely: vi.fn().mockResolvedValue(undefined) };
  return { audit, filter: new AllExceptionsFilter(audit as never) };
}

async function run(exception: unknown, req: Record<string, unknown> = {}, ctx = build()) {
  const json = vi.fn();
  const res = { status: vi.fn().mockReturnValue({ json }) };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ path: '/v1/x', requestId: 'rid-12345', method: 'GET', headers: {}, ip: '10.0.0.1', ...req }),
    }),
  } as unknown as ArgumentsHost;
  await ctx.filter.catch(exception, host);
  return { status: res.status.mock.calls[0]![0] as number, body: json.mock.calls[0]![0], audit: ctx.audit };
}

const principal = { user: { id: 'u1' }, context: { clinicId: 'c1', branchId: null } };

describe('AllExceptionsFilter', () => {
  it('formatea errores HTTP de forma consistente', async () => {
    const { status, body } = await run(new ForbiddenException('No permitido'));
    expect(status).toBe(403);
    expect(body).toMatchObject({ statusCode: 403, error: 'Acceso denegado', message: 'No permitido', path: '/v1/x', requestId: 'rid-12345' });
    expect(body.timestamp).toBeTruthy();
  });

  it('conserva los mensajes de validación como lista', async () => {
    const { body } = await run(new BadRequestException(['email inválido', 'password corto']));
    expect(body.message).toEqual(['email inválido', 'password corto']);
  });

  it('en errores no controlados oculta el detalle interno', async () => {
    Logger.overrideLogger(false);
    const { status, body } = await run(new Error('SELECT * FROM users WHERE password=secreto'));
    expect(status).toBe(500);
    expect(body.message).toBe('Error interno del servidor');
    expect(JSON.stringify(body)).not.toContain('secreto');
  });

  describe('auditoría de accesos denegados (403)', () => {
    const route = { route: { path: '/v1/patients/:id' }, method: 'GET', principal, denial: { reason: 'missing_permission', required: ['patient:read'] } };

    it('registra el 403 de un usuario autenticado con ruta (patrón), motivo y permisos, sin datos de la solicitud', async () => {
      const { audit } = await run(new ForbiddenException('No tiene permisos'), {
        ...route,
        originalUrl: '/v1/patients/8e5f2c5a?dni=12345678',
        body: { password: 'secreta' },
        headers: { authorization: 'Bearer eyJsecreto', 'user-agent': 'vitest' },
      });
      expect(audit.recordSafely).toHaveBeenCalledTimes(1);
      const entry = audit.recordSafely.mock.calls[0]![0];
      expect(entry).toMatchObject({
        action: 'ACCESS_DENIED',
        userId: 'u1',
        clinicId: 'c1',
        summary: { method: 'GET', route: '/v1/patients/:id', reason: 'missing_permission', requiredPermissions: ['patient:read'] },
      });
      const text = JSON.stringify(entry);
      for (const leak of ['12345678', '8e5f2c5a', 'secreta', 'eyJsecreto', 'Bearer']) expect(text).not.toContain(leak);
    });

    it('no audita sin identidad (p. ej. CSRF) ni otros códigos', async () => {
      const anon = await run(new ForbiddenException('CSRF'), { route: { path: '/v1/auth/refresh' } });
      expect(anon.audit.recordSafely).not.toHaveBeenCalled();
      const notFound = await run(new BadRequestException('x'), route);
      expect(notFound.audit.recordSafely).not.toHaveBeenCalled();
    });

    it('deduplica la misma negativa durante un minuto', async () => {
      const ctx = build();
      await run(new ForbiddenException('x'), route, ctx);
      await run(new ForbiddenException('x'), route, ctx);
      await run(new ForbiddenException('x'), { ...route, route: { path: '/v1/otra' } }, ctx);
      expect(ctx.audit.recordSafely).toHaveBeenCalledTimes(2);
    });

    it('un fallo de la auditoría no impide responder el 403', async () => {
      const ctx = build();
      ctx.audit.recordSafely.mockResolvedValue(undefined);
      const { status } = await run(new ForbiddenException('x'), route, ctx);
      expect(status).toBe(403);
    });
  });
});
