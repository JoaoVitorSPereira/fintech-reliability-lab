import type { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';
import type { Env } from '../../config/env';
import { resolveRequestId } from './request-id';

export function loggerConfig(config: ConfigService<Env, true>): Params {
  const isDevelopment =
    config.get('NODE_ENV', { infer: true }) === 'development';

  return {
    pinoHttp: {
      level: config.get('LOG_LEVEL', { infer: true }),
      genReqId: resolveRequestId,
      customAttributeKeys: { reqId: 'requestId' },
      // Every log line inside a request carries `req`. Keep it to what's needed
      // to correlate; headers are opt-in, so a new auth header can't leak.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      redact: {
        // Defense in depth for anything logged outside the serializers above.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.accessToken',
          '*.refreshToken',
        ],
        censor: '[REDACTED]',
      },
      // Probes hit these every few seconds; logging them is pure noise.
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      transport: isDevelopment
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
    },
  };
}
