import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

export type Job = {
  name: string;
  everyMs: number;
  /** Delay before the first run, so boot-time jobs don't all fire at once. */
  initialDelayMs: number;
  run: () => Promise<string>;
};

// Minimal scheduler: setInterval plus a Redis lock per run, so with several
// API instances each job runs once per interval, not once per instance.
// ponytail: in-process timers. Move to a queue (BullMQ) or a separate worker
// process when jobs need retries with state, priorities, or isolation from
// API latency.
export class JobRunner {
  private readonly logger = new Logger('MarketJobs');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(private readonly redis: Redis) {}

  schedule(job: Job): void {
    const tick = () => void this.runOnce(job);
    this.timers.push(setTimeout(tick, job.initialDelayMs));
    this.timers.push(setInterval(tick, job.everyMs));
  }

  async runOnce(job: Job): Promise<void> {
    if (this.running.has(job.name)) return; // previous run still going
    const lockKey = `md:job:${job.name}`;
    const token = randomUUID();
    const locked = await this.redis
      .set(lockKey, token, 'PX', Math.max(job.everyMs - 1_000, 1_000), 'NX')
      .catch(() => null);
    if (locked !== 'OK') return; // another instance has it (or Redis is down)

    this.running.add(job.name);
    const started = Date.now();
    try {
      const summary = await job.run();
      this.logger.log(
        `${job.name} ok in ${Date.now() - started}ms: ${summary}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `${job.name} failed after ${Date.now() - started}ms: ${message}`,
      );
    } finally {
      this.running.delete(job.name);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }
}
