import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env';

export const REDIS = Symbol('REDIS');

const CONNECT_WAIT_MS = 3_000;
const CONNECTING_STATES = new Set([
  'wait',
  'connecting',
  'connect',
  'reconnecting',
]);

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const logger = new Logger('Redis');
        const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
          // Fail fast instead of queueing commands while disconnected.
          // Redis is a cache/fan-out layer here, never the source of truth.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });

        // Log state transitions, not every reconnect attempt (one per ~2s).
        let state: 'up' | 'down' | undefined;
        redis.on('ready', () => {
          if (state === 'up') return;
          state = 'up';
          logger.log('redis connection ready');
        });
        redis.on('error', (error: Error & { code?: string }) => {
          if (state === 'down') return;
          state = 'down';
          // Dual-stack connects fail with an AggregateError whose message is
          // empty; the code (ECONNREFUSED, ETIMEDOUT...) is what's useful.
          logger.warn(
            `redis unavailable: ${error.code ?? (error.message || 'unknown')}`,
          );
        });
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // The client connects asynchronously and commands fail fast until it's
  // ready. Give it a moment at boot so the first requests don't fail
  // spuriously, but don't block startup on Redis: it isn't the source of
  // truth, and readiness reports it if it never comes up.
  async onModuleInit() {
    if (!CONNECTING_STATES.has(this.redis.status)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CONNECT_WAIT_MS);
      this.redis.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
