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
import { JobRunner } from '../../infrastructure/jobs/job-runner';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { LedgerService } from './ledger.service';

// The database already refuses unbalanced or overdrawn writes. This job is
// the independent check that those guards (and the balance trigger) still
// hold in production: drift means a bug or manual tampering, so it pages.
@Injectable()
export class LedgerReconciliation
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly runner: JobRunner;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ledger: LedgerService,
    @Inject(REDIS) redis: Redis,
    @InjectPinoLogger(LedgerReconciliation.name)
    private readonly logger: PinoLogger,
  ) {
    this.runner = new JobRunner(redis);
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('RECONCILIATION_ENABLED', { infer: true })) return;
    this.runner.schedule({
      name: 'ledger-reconciliation',
      everyMs: 60 * 60_000,
      initialDelayMs: 30_000,
      run: () => this.run(),
    });
  }

  onApplicationShutdown(): void {
    this.runner.stop();
  }

  async run(): Promise<string> {
    const report = await this.ledger.verifyIntegrity();
    if (!report.ok) {
      // Ids and counts only: balances are sensitive and stay out of logs.
      this.logger.error(
        {
          driftedAccountIds: report.driftedAccounts.map(
            (account) => account.accountId,
          ),
          unbalancedCurrencies: report.unbalancedCurrencies.map(
            (row) => row.currency,
          ),
        },
        'LEDGER INTEGRITY CHECK FAILED',
      );
    }
    return report.ok ? 'ledger reconciled' : 'LEDGER DRIFT DETECTED';
  }
}
