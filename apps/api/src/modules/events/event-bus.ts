import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter, on } from 'node:events';
import type { Redis } from 'ioredis';
import { REDIS } from '../../infrastructure/redis/redis.module';

const DEDUPE_WINDOW = 10_000;

// One Redis subscriber connection per API instance, fanned out in-process to
// every GraphQL subscription. Redis pub/sub is fire-and-forget: a message
// published while this connection is down is lost. That's acceptable only
// because clients recover from the durable outbox (missedEvents query).
@Injectable()
export class EventBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventBus');
  private readonly emitter = new EventEmitter();
  private readonly recentIds = new Set<string>();
  private subscriber: Redis | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.emitter.setMaxListeners(0); // one listener per active subscription
  }

  async onModuleInit(): Promise<void> {
    // Subscribers need the offline queue: SUBSCRIBE must survive reconnects
    // (ioredis re-subscribes automatically once the connection is back).
    this.subscriber = this.redis.duplicate({
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    this.subscriber.on('message', (channel: string, raw: string) =>
      this.dispatch(channel, raw),
    );
    this.subscriber.on('error', () => undefined); // state changes are logged by the main client
    await this.subscriber
      .subscribe('events:account', 'events:portfolio', 'md:prices')
      .catch((error: unknown) => {
        this.logger.warn(
          `subscribe failed, will retry on reconnect: ${String(error)}`,
        );
      });
  }

  async onModuleDestroy(): Promise<void> {
    this.emitter.removeAllListeners();
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  /** Test hook and internal entry point: deliver a raw channel message. */
  dispatch(channel: string, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    // At-least-once upstream: drop duplicates of recently seen events.
    const id = (message as { id?: unknown }).id;
    if (typeof id === 'string') {
      if (this.recentIds.has(id)) return;
      this.recentIds.add(id);
      if (this.recentIds.size > DEDUPE_WINDOW)
        this.recentIds.delete(this.recentIds.values().next().value!);
    }
    this.emitter.emit(channel, message);
  }

  /** Async iterator of messages on a channel; stops when the consumer returns. */
  async *listen<T>(channel: string, signal?: AbortSignal): AsyncGenerator<T> {
    for await (const [message] of on(this.emitter, channel, { signal })) {
      yield message as T;
    }
  }
}
