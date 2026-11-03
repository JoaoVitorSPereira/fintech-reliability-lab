import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env';
import { JobRunner } from '../../infrastructure/jobs/job-runner';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { OrdersService } from './orders.service';
import { PortfolioService } from './portfolio.service';

@Injectable()
export class TradingJobs
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly runner: JobRunner;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly orders: OrdersService,
    private readonly portfolios: PortfolioService,
    @Inject(REDIS) redis: Redis,
  ) {
    this.runner = new JobRunner(redis);
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('ORDER_MATCHING_ENABLED', { infer: true })) return;
    // ponytail: polls every 2s. Trigger on price events if fills must land faster.
    this.runner.schedule({
      name: 'limit-order-matcher',
      everyMs: 2_000,
      initialDelayMs: 5_000,
      run: () => this.orders.matchPendingOrders(),
    });
    this.runner.schedule({
      name: 'portfolio-valuations',
      everyMs: 15 * 60_000,
      initialDelayMs: 60_000,
      run: () => this.portfolios.recordValuations(),
    });
  }

  onApplicationShutdown(): void {
    this.runner.stop();
  }
}
