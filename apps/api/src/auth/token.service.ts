import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import type { AccessTokenPayload, ActiveContext } from './auth.types.js';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  get expiresIn(): number {
    return this.config.jwt.accessTtlSeconds;
  }

  sign(userId: string, sessionId: string, context?: ActiveContext): Promise<string> {
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId, ...(context ? { ctx: context } : {}) };
    return this.jwt.signAsync(payload, {
      secret: this.config.jwt.secret,
      algorithm: 'HS256',
      issuer: this.config.jwt.issuer,
      audience: this.config.jwt.audience,
      expiresIn: this.config.jwt.accessTtlSeconds,
    });
  }

  async verify(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.jwt.secret,
        algorithms: ['HS256'],
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
      });
      if (typeof payload.sub !== 'string') throw new Error('sub inválido');
      if (typeof payload.sid !== 'string') throw new Error('sid inválido');
      const ctx = payload.ctx;
      if (
        ctx !== undefined &&
        !(
          typeof ctx === 'object' &&
          ctx !== null &&
          (ctx.clinicId === null || typeof ctx.clinicId === 'string') &&
          (ctx.branchId === null || typeof ctx.branchId === 'string')
        )
      ) {
        throw new Error('ctx inválido');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
