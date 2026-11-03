import { NestFactory } from '@nestjs/core';

// Ops command: `pnpm --filter api ledger:verify`. Exit code 0 = reconciled,
// 1 = drift (details in the output). Background jobs are switched off so the
// command never publishes events or touches market data.
async function main(): Promise<void> {
  for (const flag of [
    'MARKET_INGESTION_ENABLED',
    'ORDER_MATCHING_ENABLED',
    'OUTBOX_PUBLISHER_ENABLED',
    'RECONCILIATION_ENABLED',
  ]) {
    process.env[flag] = 'false';
  }
  const { AppModule } = await import('../app.module.js');
  const { LedgerService } = await import('../modules/ledger/ledger.service.js');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const report = await app.get(LedgerService).verifyIntegrity();
  await app.close();
  process.stdout.write(
    `${JSON.stringify(report, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

void main();
