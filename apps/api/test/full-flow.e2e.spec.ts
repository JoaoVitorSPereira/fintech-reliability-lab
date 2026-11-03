import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AddressInfo } from 'node:net';
import { type Client, createClient } from 'graphql-ws';
import type { App } from 'supertest/types';
import WebSocket from 'ws';
import type { Redis } from 'ioredis';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { REDIS } from '../src/infrastructure/redis/redis.module';
import { OutboxPublisher } from '../src/modules/events/outbox-publisher.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { MarketIngestionService } from '../src/modules/market-data/ingestion/market-ingestion.service';
import { QuoteStore } from '../src/modules/market-data/quote-store';
import { FakeProvider } from './fake-provider';
import { createTestApp, errorCode, gql } from './graphql';

// The spec's end-to-end scenario, in order, against a running server, real
// Postgres and Redis, a real WebSocket client, and a fake market-data
// provider (the only fake: external APIs are never called from tests).

const key = () => crypto.randomUUID();
const run = key().slice(0, 6);
const PASSWORD = 'a perfectly long passphrase';

describe('Full user journey (spec section 14, steps 1-18)', () => {
  const fake = new FakeProvider();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let wsUrl: string;
  const clients: Client[] = [];

  // Shared across the ordered steps below.
  let access = '';
  let refresh = '';
  let checkingId = '';
  let portfolio = { id: '', cashAccountId: '' };
  let coinId = '';
  let friendAccount = '';

  beforeAll(async () => {
    await fake.start();
    const now = Date.now();
    const hour = 3_600_000;
    fake.routes.set('/cg/coins/markets', () => ({
      body: [
        {
          id: `journey-${run}`,
          symbol: `j${run}`,
          name: 'Journey Coin',
          image: null,
          current_price: 100,
          market_cap: 5e9,
          market_cap_rank: 1,
          total_volume: 1e8,
          price_change_percentage_24h: 2.5,
          last_updated: new Date().toISOString(),
        },
      ],
    }));
    fake.routes.set('/cg/global', () => ({
      body: {
        data: {
          total_market_cap: { usd: 1 },
          market_cap_percentage: { btc: 50 },
          updated_at: now / 1000,
        },
      },
    }));
    fake.routes.set('/bn/api/v3/ticker/price', () => ({
      body: [{ symbol: `J${run.toUpperCase()}USDT`, price: '100' }],
    }));
    fake.routes.set('/bn/api/v3/klines', () => ({
      body: Array.from({ length: 24 }, (_, i) => [
        Math.floor(now / hour) * hour - (23 - i) * hour,
        '99',
        '102',
        '98',
        '100',
        '5',
      ]),
    }));
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    wsUrl = `ws://127.0.0.1:${(app.getHttpServer() as unknown as { address(): AddressInfo }).address().port}/graphql`;
    prisma = app.get(PrismaService);
    publisher = app.get(OutboxPublisher);
    await prisma.$executeRaw`UPDATE outbox_events SET published_at = now()
      WHERE published_at IS NULL AND failed_at IS NULL AND occurred_at < now() - interval '2 minutes'`;
  });

  afterAll(async () => {
    await Promise.all(
      clients.map((client) => Promise.resolve(client.dispose())),
    );
    await app.close();
    await fake.stop();
  });

  function ws(): Client {
    const client = createClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      retryAttempts: 0,
      connectionParams: () => ({ authorization: `Bearer ${access}` }),
    });
    clients.push(client);
    return client;
  }

  async function until(check: () => boolean, ms = 3_000) {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function setLivePrice(price: string) {
    const now = new Date().toISOString();
    await app.get(QuoteStore).write([
      {
        assetId: coinId,
        price,
        currency: 'USDT',
        provider: 'binance-stream',
        sourceTimestamp: now,
        fetchedAt: now,
      },
    ]);
  }

  it('1. authenticates', async () => {
    const res = await gql<{
      register: { accessToken: string; refreshToken: string };
    }>(
      app,
      `mutation R($input: RegisterInput!) { register(input: $input) { accessToken refreshToken } }`,
      { input: { email: `journey-${run}@example.com`, password: PASSWORD } },
    );
    ({ accessToken: access, refreshToken: refresh } = res.data!.register);
    checkingId = (
      await gql<{ accounts: { id: string }[] }>(
        app,
        '{ accounts { id } }',
        {},
        access,
      )
    ).data!.accounts[0]!.id;
    expect(access).toBeTruthy();
  });

  it('2-3. loads the dashboard and crypto listings from ingested market data', async () => {
    await app.get(MarketIngestionService).syncCryptoListings();
    const res = await gql<{
      marketOverview: { topGainers: unknown[] };
      assets: {
        nodes: {
          id: string;
          symbol: string;
          quote: { price: string; dataQuality: string };
        }[];
      };
    }>(
      app,
      `query($s: String) { marketOverview { topGainers { symbol } } assets(first: 5, search: $s) { nodes { id symbol quote { price dataQuality } } } }`,
      { s: `J${run.toUpperCase()}` },
      access,
    );
    expect(res.errors).toBeUndefined();
    const coin = res.data!.assets.nodes[0]!;
    coinId = coin.id;
    expect(coin.quote).toEqual({ price: '100', dataQuality: 'CACHED' });
  });

  it('4. retrieves historical chart data', async () => {
    const res = await gql<{
      assetCandles: { provider: string; candles: unknown[] };
    }>(
      app,
      `query($id: ID!, $from: DateTime!, $to: DateTime!) { assetCandles(assetId: $id, timeframe: H1, from: $from, to: $to) { provider candles { close } } }`,
      {
        id: coinId,
        from: new Date(Date.now() - 23 * 3_600_000).toISOString(),
        to: new Date().toISOString(),
      },
      access,
    );
    expect(res.data!.assetCandles.provider).toBe('binance');
    expect(res.data!.assetCandles.candles.length).toBeGreaterThanOrEqual(23);
  });

  it('5. subscribes to live market updates', async () => {
    const prices: string[] = [];
    ws().subscribe<{ marketPriceUpdated: { price: string } }>(
      {
        query: `subscription($ids: [ID!]!) { marketPriceUpdated(assetIds: $ids) { price } }`,
        variables: { ids: [coinId] },
      },
      {
        next: (v) => v.data && prices.push(v.data.marketPriceUpdated.price),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.get<Redis>(REDIS).publish(
      'md:prices',
      JSON.stringify({
        assetId: coinId,
        price: '101',
        change24hPct: '1',
        sourceTimestamp: new Date().toISOString(),
      }),
    );
    await until(() => prices.length === 1);
    expect(prices).toEqual(['101']);
  });

  it('6. creates a watchlist', async () => {
    const res = await gql<{ createWatchlistItem: { asset: { id: string } } }>(
      app,
      `mutation($id: ID!) { createWatchlistItem(assetId: $id) { asset { id } } }`,
      { id: coinId },
      access,
    );
    expect(res.data!.createWatchlistItem.asset.id).toBe(coinId);
  });

  it('7-8. creates a simulated buy order and verifies the position', async () => {
    portfolio = (
      await gql<{ createPortfolio: typeof portfolio }>(
        app,
        'mutation { createPortfolio { id cashAccountId } }',
        {},
        access,
      )
    ).data!.createPortfolio;
    await gql(
      app,
      `mutation($input: SimulateDepositInput!) { simulateDeposit(input: $input) { transfer { id } } }`,
      {
        input: {
          accountId: portfolio.cashAccountId,
          amount: '1000',
          idempotencyKey: key(),
        },
      },
      access,
    );
    await setLivePrice('100');
    const buy = await gql<{
      createSimulatedOrder: { order: { status: string } };
    }>(
      app,
      `mutation($input: SimulatedOrderInput!) { createSimulatedOrder(input: $input) { order { status } } }`,
      {
        input: {
          assetId: coinId,
          side: 'BUY',
          type: 'MARKET',
          quantity: '2',
          idempotencyKey: key(),
        },
      },
      access,
    );
    expect(buy.data!.createSimulatedOrder.order.status).toBe('FILLED');
    const p = await gql<{
      portfolio: { positions: { quantity: string; averagePrice: string }[] };
    }>(
      app,
      '{ portfolio { positions { quantity averagePrice } } }',
      {},
      access,
    );
    expect(p.data!.portfolio.positions).toEqual([
      { quantity: '2', averagePrice: '100' },
    ]);
  });

  it('9-10. executes a simulated sell and verifies realized P&L', async () => {
    await setLivePrice('130');
    const sell = await gql<{
      createSimulatedOrder: {
        order: { trade: { realizedPnl: { amount: string } } };
      };
    }>(
      app,
      `mutation($input: SimulatedOrderInput!) { createSimulatedOrder(input: $input) { order { trade { realizedPnl { amount } } } } }`,
      {
        input: {
          assetId: coinId,
          side: 'SELL',
          type: 'MARKET',
          quantity: '1',
          idempotencyKey: key(),
        },
      },
      access,
    );
    expect(sell.data!.createSimulatedOrder.order.trade.realizedPnl.amount).toBe(
      '30.00',
    );
  });

  it('11-12. disconnects the WebSocket, then recovers the missed updates', async () => {
    const before = await gql<{ missedEvents: { sequence: number }[] }>(
      app,
      `query($s: EventStreamInput!) { missedEvents(stream: $s, afterSequence: 0) { sequence } }`,
      { s: { type: 'PORTFOLIO', id: portfolio.id } },
      access,
    );
    const lastSeen = before.data!.missedEvents.at(-1)!.sequence;
    // While "offline": another order changes the portfolio.
    await gql(
      app,
      `mutation($input: SimulatedOrderInput!) { createSimulatedOrder(input: $input) { order { id } } }`,
      {
        input: {
          assetId: coinId,
          side: 'BUY',
          type: 'LIMIT',
          quantity: '1',
          limitPrice: '50',
          idempotencyKey: key(),
        },
      },
      access,
    );
    const missed = await gql<{
      missedEvents: { sequence: number; type: string }[];
    }>(
      app,
      `query($s: EventStreamInput!, $after: Int!) { missedEvents(stream: $s, afterSequence: $after) { sequence type } }`,
      { s: { type: 'PORTFOLIO', id: portfolio.id }, after: lastSeen },
      access,
    );
    expect(missed.data!.missedEvents).toEqual([
      { sequence: lastSeen + 1, type: 'SimulatedOrderUpdated' },
    ]);
  });

  it('13. rejects an expired access token, and the refresh token gets a new one', async () => {
    const expired = await app.get(JwtService).signAsync(
      { sid: 'irrelevant', exp: Math.floor(Date.now() / 1000) - 10 },
      {
        subject: 'irrelevant',
        issuer: 'fintech-reliability-lab-api',
        audience: 'fintech-reliability-lab-app',
        algorithm: 'HS256',
      },
    );
    expect(errorCode(await gql(app, '{ me { id } }', {}, expired))).toBe(
      'UNAUTHENTICATED',
    );
    const res = await gql<{
      refreshSession: { accessToken: string; refreshToken: string };
    }>(
      app,
      `mutation($t: String!) { refreshSession(refreshToken: $t) { accessToken refreshToken } }`,
      { t: refresh },
    );
    ({ accessToken: access, refreshToken: refresh } = res.data!.refreshSession);
    expect(
      (await gql<{ me: { id: string } }>(app, '{ me { id } }', {}, access))
        .data!.me.id,
    ).toBeTruthy();
  });

  it('14. survives concurrent refreshes of the same token without killing the session', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        gql<{ refreshSession: { accessToken: string; refreshToken: string } }>(
          app,
          `mutation($t: String!) { refreshSession(refreshToken: $t) { accessToken refreshToken } }`,
          { t: refresh },
        ),
      ),
    );
    const ok = results.filter((r) => r.data?.refreshSession);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    ({ accessToken: access, refreshToken: refresh } =
      ok.at(-1)!.data!.refreshSession);
    expect(
      (await gql<{ me: { id: string } }>(app, '{ me { id } }', {}, access))
        .data!.me.id,
    ).toBeTruthy();
  });

  it('15. applies duplicate transfer requests once', async () => {
    await gql(
      app,
      `mutation($input: SimulateDepositInput!) { simulateDeposit(input: $input) { transfer { id } } }`,
      {
        input: { accountId: checkingId, amount: '1000', idempotencyKey: key() },
      },
      access,
    );
    const friend = await gql<{ register: { accessToken: string } }>(
      app,
      `mutation R($input: RegisterInput!) { register(input: $input) { accessToken } }`,
      { input: { email: `friend-${run}@example.com`, password: PASSWORD } },
    );
    friendAccount = (
      await gql<{ accounts: { id: string }[] }>(
        app,
        '{ accounts { id } }',
        {},
        friend.data!.register.accessToken,
      )
    ).data!.accounts[0]!.id;
    const idempotencyKey = key();
    const send = () =>
      gql<{ createTransfer: { transfer: { id: string } } }>(
        app,
        `mutation($input: CreateTransferInput!) { createTransfer(input: $input) { transfer { id } } }`,
        {
          input: {
            fromAccountId: checkingId,
            toAccountId: friendAccount,
            amount: '100',
            idempotencyKey,
          },
        },
        access,
      );
    const results = await Promise.all([send(), send(), send()]);
    expect(
      new Set(results.map((r) => r.data!.createTransfer.transfer.id)).size,
    ).toBe(1);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: checkingId } }))
        .balance,
    ).toBe(90_000n);
  });

  it('16. lets only one of two concurrent R$800 withdrawals through', async () => {
    const other = friendAccount; // never another suite's account: suites run in parallel
    const send = () =>
      gql(
        app,
        `mutation($input: CreateTransferInput!) { createTransfer(input: $input) { transfer { id } } }`,
        {
          input: {
            fromAccountId: checkingId,
            toAccountId: other,
            amount: '800',
            idempotencyKey: key(),
          },
        },
        access,
      );
    const results = await Promise.all([send(), send()]);
    expect(results.map(errorCode).filter(Boolean)).toEqual([
      'INSUFFICIENT_FUNDS',
    ]);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: checkingId } }))
        .balance,
    ).toBe(10_000n);
  });

  it('17. delivers events committed while the worker was down, after it restarts', async () => {
    const updates: number[] = [];
    ws().subscribe<{ accountUpdated: { sequence: number } }>(
      {
        query: `subscription($id: ID!) { accountUpdated(accountId: $id) { sequence } }`,
        variables: { id: checkingId },
      },
      {
        next: (v) => v.data && updates.push(v.data.accountUpdated.sequence),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The publisher isn't running in tests: these events wait in the outbox,
    // exactly as they would during a worker crash.
    await gql(
      app,
      `mutation($input: SimulateDepositInput!) { simulateDeposit(input: $input) { transfer { id } } }`,
      { input: { accountId: checkingId, amount: '5', idempotencyKey: key() } },
      access,
    );
    const pending = await prisma.outboxEvent.count({
      where: { aggregateId: checkingId, publishedAt: null },
    });
    expect(pending).toBeGreaterThan(0);
    // "Restart": like the real worker loop, keep publishing until caught up.
    // Other suites run in parallel and leave their own backlog in front of
    // ours (oldest first), so one fixed-size drain isn't enough.
    const stillPending = () =>
      prisma.outboxEvent.count({
        where: { aggregateId: checkingId, publishedAt: null },
      });
    const deadline = Date.now() + 15_000;
    while ((await stillPending()) > 0 && Date.now() < deadline)
      await publisher.drain();
    await until(() => updates.length > 0);
    expect(await stillPending()).toBe(0);
  });

  it('18. verifies ledger integrity', async () => {
    expect(await app.get(LedgerService).verifyIntegrity()).toEqual({
      ok: true,
      driftedAccounts: [],
      unbalancedCurrencies: [],
    });
  });
});
