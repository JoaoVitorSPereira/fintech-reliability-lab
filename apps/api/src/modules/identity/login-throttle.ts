import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppError } from '../../shared/errors/app-error';
import { REDIS } from '../../infrastructure/redis/redis.module';

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

// Slows online password guessing against one account. Counts failures per
// email (hashed: no plaintext emails in Redis), whether or not the account
// exists, so the limiter itself doesn't reveal which emails are registered.
//
// ponytail: per-account only. Add a per-IP limit once the API sits behind a
// proxy with a trusted X-Forwarded-For; a lockout can also be triggered by
// an attacker on purpose (15-minute DoS of a known email), accepted for now.
@Injectable()
export class LoginThrottle {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @InjectPinoLogger(LoginThrottle.name) private readonly logger: PinoLogger,
  ) {}

  async assertAllowed(email: string) {
    const failures = await this.safely(() => this.redis.get(this.key(email)));
    if (Number(failures ?? 0) >= MAX_FAILURES) {
      throw new AppError(
        'TOO_MANY_ATTEMPTS',
        'Too many failed sign-in attempts. Try again later.',
      );
    }
  }

  async recordFailure(email: string) {
    const key = this.key(email);
    await this.safely(() =>
      this.redis.multi().incr(key).expire(key, WINDOW_SECONDS, 'NX').exec(),
    );
  }

  async reset(email: string) {
    await this.safely(() => this.redis.del(this.key(email)));
  }

  private key(email: string) {
    return `auth:login-failures:${createHash('sha256').update(email).digest('hex')}`;
  }

  // Fail open: if Redis is down, sign-in keeps working without throttling.
  // Locking every user out because a cache is down would be worse.
  private async safely<T>(operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      this.logger.warn(
        { err: (error as Error).message },
        'login throttle unavailable, failing open',
      );
      return null;
    }
  }
}
