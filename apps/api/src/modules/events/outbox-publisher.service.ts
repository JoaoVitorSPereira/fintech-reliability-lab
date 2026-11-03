import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import {
  type AggregateType,
  type DomainEvent,
  EVENT_CHANNEL,
} from './domain-event';

const BATCH_SIZE = 100;
const POLL_MS = 250;
export const MAX_ATTEMPTS = 12;
const RETENTION_DAYS = 30;

type OutboxRow = {
  id: string;
  aggregate_type: AggregateType;
  aggregate_id: string;
  sequence: number;
  type: string;
  version: number;
  payload: unknown;
  correlation_id: string | null;
  occurred_at: Date;
  attempts: number;
};

/** Exponential backoff with jitter: ~0.5s, 1s, 2s ... capped at 5 min. */
export function nextAttemptDelayMs(attempts: number): number {
  const base = Math.min(500 * 2 ** attempts, 5 * 60_000);
  return Math.round(base / 2 + (Math.random() * base) / 2);
}

export function toDomainEvent(row: OutboxRow): DomainEvent {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at.toISOString(),
    correlationId: row.correlation_id,
    payload: row.payload,
  };
}

// Delivery is AT-LEAST-ONCE: an event is published, then marked published.
// A crash in between republishes it, so consumers dedupe on `id` (and order
// by `sequence`). Exactly-once delivery isn't claimed anywhere.
@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer: NodeJS.Timeout | null = null;
  private retention: NodeJS.Timeout | null = null;
  private running = false;
  private lastReportAt = 0;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectPinoLogger(OutboxPublisher.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('OUTBOX_PUBLISHER_ENABLED', { infer: true })) return;
    // Anything committed while the worker was down is still in the table:
    // restarting simply resumes from there.
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.retention = setInterval(
      () => void this.prune().catch(() => undefined),
      6 * 60 * 60_000,
    );
    this.logger.info('outbox publisher started');
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retention) clearInterval(this.retention);
  }

  /** Publish everything that's due. Used by the worker loop and by tests. */
  async drain(maxBatches = 50): Promise<{ published: number; failed: number }> {
    const total = { published: 0, failed: 0 };
    for (let i = 0; i < maxBatches; i++) {
      const batch = await this.publishBatch();
      total.published += batch.published;
      total.failed += batch.failed;
      if (batch.published + batch.failed === 0) break;
    }
    return total;
  }

  async stats(): Promise<{
    pending: number;
    deadLettered: number;
    oldestPendingSeconds: number | null;
  }> {
    const [row] = await this.prisma.$queryRaw<
      { pending: bigint; dead: bigint; oldest: Date | null }[]
    >`
      SELECT count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL) AS pending,
             count(*) FILTER (WHERE failed_at IS NOT NULL) AS dead,
             min(occurred_at) FILTER (WHERE published_at IS NULL AND failed_at IS NULL) AS oldest
      FROM outbox_events`;
    return {
      pending: Number(row?.pending ?? 0),
      deadLettered: Number(row?.dead ?? 0),
      oldestPendingSeconds: row?.oldest
        ? Math.round((Date.now() - row.oldest.getTime()) / 1000)
        : null,
    };
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drain(20);
      if (Date.now() - this.lastReportAt > 30_000) {
        this.lastReportAt = Date.now();
        const stats = await this.stats();
        if (stats.pending > 0 || stats.deadLettered > 0)
          this.logger.info(stats, 'outbox backlog');
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'outbox publish cycle failed');
    } finally {
      this.running = false;
    }
  }

  async publishBatch(): Promise<{ published: number; failed: number }> {
    return this.prisma.$transaction(async (tx) => {
      // SKIP LOCKED: several instances can publish in parallel without
      // taking the same rows. NOT EXISTS: an aggregate's event waits until
      // every earlier event of that aggregate is published (or dead), so
      // per-aggregate order holds even across retries.
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT e.id, e.aggregate_type, e.aggregate_id, e.sequence, e.type, e.version, e.payload,
               e.correlation_id, e.occurred_at, e.attempts
        FROM outbox_events e
        WHERE e.published_at IS NULL AND e.failed_at IS NULL AND e.next_attempt_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM outbox_events p
            WHERE p.aggregate_type = e.aggregate_type AND p.aggregate_id = e.aggregate_id
              AND p.sequence < e.sequence AND p.published_at IS NULL AND p.failed_at IS NULL)
        ORDER BY e.occurred_at, e.id
        LIMIT ${BATCH_SIZE}
        FOR UPDATE OF e SKIP LOCKED`;
      if (rows.length === 0) return { published: 0, failed: 0 };

      const published: string[] = [];
      let failed = 0;
      for (const row of rows) {
        try {
          await this.redis.publish(
            EVENT_CHANNEL[row.aggregate_type],
            JSON.stringify(toDomainEvent(row)),
          );
          published.push(row.id);
        } catch (error) {
          failed++;
          const attempts = row.attempts + 1;
          const message =
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'unknown error';
          if (attempts >= MAX_ATTEMPTS) {
            await tx.outboxEvent.update({
              where: { id: row.id },
              data: { attempts, lastError: message, failedAt: new Date() },
            });
            this.logger.error(
              { eventId: row.id, type: row.type, attempts },
              'outbox event dead-lettered',
            );
          } else {
            await tx.outboxEvent.update({
              where: { id: row.id },
              data: {
                attempts,
                lastError: message,
                nextAttemptAt: new Date(
                  Date.now() + nextAttemptDelayMs(attempts),
                ),
              },
            });
          }
        }
      }
      if (published.length > 0) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: published } },
          data: { publishedAt: new Date() },
        });
        const lagMs =
          Date.now() -
          Math.min(...rows.map((row) => row.occurred_at.getTime()));
        this.logger.debug(
          { published: published.length, failed, maxLagMs: lagMs },
          'outbox batch published',
        );
      }
      return { published: published.length, failed };
    });
  }

  // ponytail: published events are the replay source for reconnecting
  // clients; keep 30 days, then delete. Archive to object storage if audit
  // ever needs them longer (the ledger is the financial record, not this).
  private async prune(): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM outbox_events WHERE published_at < now() - make_interval(days => ${RETENTION_DAYS})`;
  }
}
