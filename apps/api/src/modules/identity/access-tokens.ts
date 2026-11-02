import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = 'fintech-reliability-lab-api';
const AUDIENCE = 'fintech-reliability-lab-app';

export type AccessTokenClaims = { userId: string; sessionId: string };

@Injectable()
export class AccessTokens {
  constructor(private readonly jwt: JwtService) {}

  async sign(claims: AccessTokenClaims, now = new Date()) {
    const token = await this.jwt.signAsync(
      { sid: claims.sessionId },
      {
        subject: claims.userId,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithm: 'HS256',
      },
    );
    const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    return { token, expiresAt };
  }

  // Returns null for anything invalid: expired, bad signature, wrong
  // issuer/audience, unexpected algorithm (blocks "alg: none" tricks), or
  // a payload missing the claims we rely on.
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(
        token,
        { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE },
      );
      const { sub, sid } = payload;
      if (typeof sub !== 'string' || typeof sid !== 'string') return null;
      return { userId: sub, sessionId: sid };
    } catch {
      return null;
    }
  }
}
