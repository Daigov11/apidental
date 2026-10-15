import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import { TokenService } from './token.service.js';

const env = {
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
  JWT_ACCESS_SECRET: 's'.repeat(48),
  JWT_ACCESS_TTL_SECONDS: '900',
};

function service(overrides: Record<string, string> = {}) {
  return new TokenService(new JwtService(), new AppConfig({ ...env, ...overrides }));
}

describe('TokenService', () => {
  it('firma y verifica sin contexto y con contexto', async () => {
    const s = service();
    expect(await s.verify(await s.sign('user-1', 'sess-1'))).toMatchObject({ sub: 'user-1', sid: 'sess-1' });
    const withCtx = await s.verify(await s.sign('user-1', 'sess-1', { clinicId: 'c1', branchId: null }));
    expect(withCtx.ctx).toEqual({ clinicId: 'c1', branchId: null });
  });

  it('el token expira según el TTL configurado', async () => {
    const s = service();
    const payload = JSON.parse(Buffer.from((await s.sign('u', 'sess-1')).split('.')[1]!, 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('rechaza tokens manipulados, de otro secreto o de otra audiencia', async () => {
    const s = service();
    const good = await s.sign('u', 'sess-1');
    await expect(s.verify(good.slice(0, -2) + 'xx')).rejects.toThrow(UnauthorizedException);
    await expect(service({ JWT_ACCESS_SECRET: 'z'.repeat(48) }).verify(good)).rejects.toThrow(UnauthorizedException);
    await expect(service({ JWT_AUDIENCE: 'otra' }).verify(good)).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza alg=none', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u', iss: 'apidental-api', aud: 'apidental-admin' })}.`;
    await expect(service().verify(none)).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza un contexto con forma inválida', async () => {
    const jwt = new JwtService();
    const cfg = new AppConfig(env);
    const bad = await jwt.signAsync(
      { sub: 'u', sid: 's', ctx: { clinicId: 5 } },
      { secret: cfg.jwt.secret, issuer: cfg.jwt.issuer, audience: cfg.jwt.audience, expiresIn: 60 },
    );
    await expect(service().verify(bad)).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza un token sin id de sesión (no se puede ligar a una sesión revocable)', async () => {
    const jwt = new JwtService();
    const cfg = new AppConfig(env);
    const noSid = await jwt.signAsync(
      { sub: 'u' },
      { secret: cfg.jwt.secret, issuer: cfg.jwt.issuer, audience: cfg.jwt.audience, expiresIn: 60 },
    );
    await expect(service().verify(noSid)).rejects.toThrow(UnauthorizedException);
  });
});
