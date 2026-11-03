import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { Metrics } from '../src/infrastructure/metrics/metrics';
import { MarketDataLoaders } from '../src/modules/market-data/market-data.loaders';
import { MarketDataService } from '../src/modules/market-data/market-data.service';
import { QuoteStore } from '../src/modules/market-data/quote-store';
import { createTestApp, gql, registerUser, type TestUser } from './graphql';

// `pnpm --filter api bench`. Measurements, not assertions: numbers vary by
// machine. Each experiment compares an intentionally naive version with the
// shipped one on the same data, and prints a markdown table.

jest.setTimeout(300_000);
const rows: string[] = [
  '| Experiment | Variant | p50 | p95 | Notes |',
  '| --- | --- | --- | --- | --- |',
];

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!;
}

async function measure(
  times: number,
  fn: () => Promise<unknown>,
  concurrency = 1,
): Promise<number[]> {
  const samples: number[] = [];
  let next = 0;
  async function worker() {
    while (next++ < times) {
      const start = performance.now();
      await fn();
      samples.push(performance.now() - start);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

function record(
  experiment: string,
  variant: string,
  samples: number[],
  notes = '',
) {
  rows.push(
    `| ${experiment} | ${variant} | ${percentile(samples, 50).toFixed(2)} ms | ${percentile(samples, 95).toFixed(2)} ms | ${notes} |`,
  );
}

describe('performance experiments', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    process.stdout.write(`\n${rows.join('\n')}\n\n`);
    await app.close();
  });

  it('N+1: 25 assets with quotes and sparklines, naive vs DataLoader-batched', async () => {
    const tag = crypto.randomUUID().slice(0, 6).toUpperCase();
    const assets = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        prisma.asset.create({
          data: {
            category: 'CRYPTO',
            symbol: `B${tag}${i}`,
            name: `Bench ${i}`,
            quoteCurrency: 'USD',
          },
        }),
      ),
    );
    const now = new Date().toISOString();
    await app.get(QuoteStore).write(
      assets.map((a) => ({
        assetId: a.id,
        price: '1',
        currency: 'USD',
        provider: 'bench',
        sourceTimestamp: now,
        fetchedAt: now,
      })),
    );
    const hour = 3_600_000;
    const base = Math.floor(Date.now() / hour) * hour;
    await prisma.candle.createMany({
      data: assets.flatMap((a) =>
        Array.from({ length: 24 }, (_, h) => ({
          assetId: a.id,
          timeframe: 'H1' as const,
          openTime: new Date(base - h * hour),
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          provider: 'bench',
          fetchedAt: new Date(),
        })),
      ),
    });
    const ids = assets.map((a) => a.id);
    const store = app.get(QuoteStore);

    // Naive: what a field resolver does without DataLoader, once per row.
    const naive = await measure(30, async () => {
      for (const id of ids) {
        await store.readMany([id]);
        await prisma.$queryRaw`SELECT close FROM candles WHERE asset_id = ${id}::uuid AND timeframe = 'H1' AND open_time >= now() - interval '24 hours' ORDER BY open_time`;
      }
    });
    record('Asset list (25 rows)', 'naive: 2 round trips per row (50)', naive);

    const batched = await measure(30, async () => {
      const loaders = new MarketDataLoaders(
        store,
        prisma,
        app.get(Metrics),
        app.get(MarketDataService),
      );
      await Promise.all(
        ids.flatMap((id) => [
          loaders.quotes.load(id),
          loaders.sparklines.load(id),
        ]),
      );
    });
    record(
      'Asset list (25 rows)',
      'DataLoader: 1 Redis pipeline + 1 SQL',
      batched,
    );
  });

  it('Index: statement page for an account with 10,000 entries, with vs without (account_id, id) index', async () => {
    const user = await registerUser(app);
    const funding = await prisma.account.findUniqueOrThrow({
      where: { systemCode: 'external-funding:BRL' },
    });
    // 5,000 balanced transactions = 10,000 entries on this account (in, then out).
    await prisma.$executeRaw`
      WITH tx AS (
        INSERT INTO ledger_transactions (id, kind, description)
        SELECT gen_random_uuid(), 'DEPOSIT', 'bench' FROM generate_series(1, 5000) RETURNING id
      )
      INSERT INTO ledger_entries (id, transaction_id, account_id, currency, amount)
      SELECT gen_random_uuid(), tx.id, a.account_id, 'BRL', a.amount
      FROM tx, (VALUES (${user.accountId}::uuid, 100::bigint), (${funding.id}::uuid, -100::bigint)) AS a(account_id, amount)`;
    const statement = Prisma.sql`SELECT id FROM ledger_entries WHERE account_id = ${user.accountId}::uuid ORDER BY id DESC LIMIT 26`;

    async function explainMs(): Promise<number> {
      const plan = await prisma.$queryRaw<
        { 'QUERY PLAN': { 'Execution Time': number }[] }[]
      >`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`;
      return plan[0]!['QUERY PLAN'][0]!['Execution Time'];
    }
    const withIndex: number[] = [];
    for (let i = 0; i < 20; i++) withIndex.push(await explainMs());
    record(
      'Statement first page (10k entries)',
      'with (account_id, id) index',
      withIndex,
      'Postgres execution time',
    );

    // Drop the index inside a transaction and roll back: nothing changes for real.
    const withoutIndex = await prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`DROP INDEX ledger_entries_account_id_id_idx`;
          const samples: number[] = [];
          for (let i = 0; i < 20; i++) {
            const plan = await tx.$queryRaw<
              { 'QUERY PLAN': { 'Execution Time': number }[] }[]
            >`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`;
            samples.push(plan[0]!['QUERY PLAN'][0]!['Execution Time']);
          }
          throw Object.assign(new Error('rollback'), { samples });
        },
        { timeout: 60_000 },
      )
      .catch((error: { samples?: number[] }) => error.samples ?? []);
    record(
      'Statement first page (10k entries)',
      'without index (dropped, rolled back)',
      withoutIndex,
      'Postgres execution time',
    );
  });

  it('Contention: 200 transfers, spread across 20 senders vs all from one hot account', async () => {
    const TRANSFER = `mutation T($input: CreateTransferInput!) { createTransfer(input: $input) { transfer { id } } }`;
    const DEPOSIT = `mutation D($input: SimulateDepositInput!) { simulateDeposit(input: $input) { transfer { id } } }`;
    const users: TestUser[] = [];
    for (let i = 0; i < 21; i++) users.push(await registerUser(app));
    for (const u of users) {
      await gql(
        app,
        DEPOSIT,
        {
          input: {
            accountId: u.accountId,
            amount: '50000',
            idempotencyKey: crypto.randomUUID(),
          },
        },
        u.accessToken,
      );
    }
    const sink = users[20]!;
    let i = 0;
    const spread = await measure(
      200,
      () => {
        const from = users[i++ % 20]!;
        return gql(
          app,
          TRANSFER,
          {
            input: {
              fromAccountId: from.accountId,
              toAccountId:
                sink.accountId === from.accountId
                  ? users[0]!.accountId
                  : users[(i + 7) % 20]!.accountId,
              amount: '1',
              idempotencyKey: crypto.randomUUID(),
            },
          },
          from.accessToken,
        );
      },
      10,
    );
    record(
      '200 transfers, 10 concurrent',
      'spread over 20 senders',
      spread,
      'full GraphQL request',
    );

    const hot = users[0]!;
    let j = 0;
    const contended = await measure(
      200,
      () =>
        gql(
          app,
          TRANSFER,
          {
            input: {
              fromAccountId: hot.accountId,
              toAccountId: users[1 + (j++ % 19)]!.accountId,
              amount: '1',
              idempotencyKey: crypto.randomUUID(),
            },
          },
          hot.accessToken,
        ),
      10,
    );
    record(
      '200 transfers, 10 concurrent',
      'all from one hot account',
      contended,
      'serialized by the row lock',
    );
  });
});
