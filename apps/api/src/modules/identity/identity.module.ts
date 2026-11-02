import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../../config/env';
import { AccessTokens } from './access-tokens';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { IdentityResolver } from './identity.resolver';
import { LoginThrottle } from './login-throttle';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
    }),
  ],
  providers: [
    AccessTokens,
    AuthService,
    LoginThrottle,
    IdentityResolver,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class IdentityModule {}
