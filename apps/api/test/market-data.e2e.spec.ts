import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { App } from 'supertest/types';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { REDIS } from '../src/infrastructure/redis/redis.module';
import { MarketIngestionService } from '../src/modules/market-data/ingestion/market-ingestion.service';
import { BinanceAdapter } from '../src/modules/market-data/providers/binance';
import { CoinGeckoAdapter } from '../src/modules/market-data/providers/coingecko';
import { QuoteStore } from '../src/modules/market-data/quote-store';
import { FakeProvider } from './fake-provider';
import { createTestApp, errorCode, gql, registerUser } from './graphql';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

// Give every run its own coins so parallel runs and reruns never collide.
const run = crypto.randomUUID().slice(0, 8);
function markets(): unknown[] {
  return [
    {
      id: `alpha-${run}`,
      symbol: `a${run}`,
      name: 'Alpha',
      image: null,
      current_price: 100.5,
      market_cap: 1e9,
      market_cap_rank: 1,
      total_volume: 5e6,
      price_change_percentage_24h: 12.5,
      last_updated: new Date().toISOString(),
    },
    {
      id: `beta-${run}`,
      symbol: `b${run}`,
      name: 'Beta',
      image: null,
      current_price: 1.2e-7,
      market_cap: 2e6,
      market_cap_rank: 2,
      total_volume: 9e6,
      price_change_percentage_24h: -3.25,
      last_updated: new Date().toISOString(),
    },
  ];
}

describe('Market data (e2e, against a fake provider)', () => {
  const fake = new FakeProvider();
  let app: INestApplication<App>;
  let redis: Redis;
  let token: string;

  beforeAll(async () => {
    await fake.start();
    app = await createTestApp();
    redis = app.get(REDIS);
    token = (await registerUser(app)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  beforeEach(async () => {
    // Provider cooldowns/budgets are shared state in Redis; reset per test.
    const keys = await redis.keys('md:provider:*');
    if (keys.length) await redis.del(...keys);
    fake.routes.clear();
    fake.hits.clear();
  });

  async function ingestTwoCoins() {
    fake.routes.set('/cg/coins/markets', () => ({ body: markets() }));
    fake.routes.set('/cg/global', () => ({
      body: fixture('coingecko-global.json'),
    }));
    // Alpha is listed on Binance, Beta is not.
    fake.routes.set('/bn/api/v3/ticker/price', () => ({
      body: [{ symbol: `A${run.toUpperCase()}USDT`, price: '1' }],
    }));
    await app.get(MarketIngestionService).syncCryptoListings();
    const prisma = app.get(PrismaService);
    const alpha = await prisma.asset.findUniqueOrThrow({
      where: { coingeckoId: `alpha-${run}` },
    });
    const beta = await prisma.asset.findUniqueOrThrow({
      where: { coingeckoId: `beta-${run}` },
    });
    return { alpha, beta };
  }

  it('ingests listings into assets and quotes, with exact decimal strings', async () => {
    const { alpha, beta } = await ingestTwoCoins();
    expect(alpha.binanceSymbol).toBe(`A${run.toUpperCase()}USDT`);
    expect(beta.binanceSymbol).toBeNull();

    const res = await gql<{
      asset: { quote: Record<string, unknown>; supportedTimeframes: string[] };
    }>(
      app,
      `query($id: ID!) { asset(id: $id) { quote { price change24h marketCap provider dataQuality isStale } supportedTimeframes } }`,
      { id: beta.id },
      token,
    );
    expect(res.data!.asset.quote).toEqual({
      price: '0.00000012',
      change24h: '-3.25',
      marketCap: '2000000',
      provider: 'coingecko',
      dataQuality: 'CACHED',
      isStale: false,
    });
    // No candle provider covers Beta: no timeframes are offered, none invented.
    expect(res.data!.asset.supportedTimeframes).toEqual([]);
  });

  it('labels a quote STALE once its source timestamp is old', async () => {
    const { alpha } = await ingestTwoCoins();
    await app.get(QuoteStore).write([
      {
        assetId: alpha.id,
        sourceTimestamp: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ]);
    const res = await gql<{
      asset: { quote: { isStale: boolean; dataQuality: string } };
    }>(
      app,
      `query($id: ID!) { asset(id: $id) { quote { isStale dataQuality } } }`,
      { id: alpha.id },
      token,
    );
    expect(res.data!.asset.quote).toEqual({
      isStale: true,
      dataQuality: 'STALE',
    });
  });

  it('honors a 429 Retry-After: no further calls during the cooldown', async () => {
    fake.routes.set('/cg/coins/markets', () => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: {},
    }));
    const coingecko = app.get(CoinGeckoAdapter);

    await expect(coingecko.topMarkets(5)).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
    });
    await expect(coingecko.topMarkets(5)).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
    });
    await expect(coingecko.topMarkets(5)).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
    });

    expect(fake.hitCount('/cg/coins/markets')).toBe(1); // a 429 is never retried
    expect(await redis.pttl('md:provider:coingecko:cooldown')).toBeGreaterThan(
      25_000,
    );
  });

  it('retries a 5xx once, then gives up', async () => {
    fake.routes.set('/bn/api/v3/ticker/price', () => ({ status: 503 }));
    await expect(app.get(BinanceAdapter).listedSymbols()).rejects.toMatchObject(
      { kind: 'UNAVAILABLE' },
    );
    expect(fake.hitCount('/bn/api/v3/ticker/price')).toBe(2);
  });

  it('stops calling a provider once its per-minute budget is spent', async () => {
    fake.routes.set('/cg/global', () => ({
      body: fixture('coingecko-global.json'),
    }));
    const coingecko = app.get(CoinGeckoAdapter);
    // The budget is a fixed one-minute window: a burst that straddles the
    // minute boundary gets two budgets. Don't start within 2s of it.
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 58_000)
      await new Promise((resolve) => setTimeout(resolve, 60_500 - intoMinute));
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => coingecko.global()),
    );
    const exhausted = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r.reason as { kind: string }).kind === 'BUDGET_EXHAUSTED',
    );
    expect(exhausted.length).toBe(12 - 8);
    expect(fake.hitCount('/cg/global')).toBe(8);
  });

  it('serves stored candles, flagged stale, when the provider is down', async () => {
    const { alpha } = await ingestTwoCoins();
    const now = Date.now();
    const hour = 3_600_000;
    const start = Math.floor(now / hour) * hour - 4 * hour;
    const klines = Array.from({ length: 5 }, (_, i) => [
      start + i * hour,
      '100.0',
      '110.0',
      '95.0',
      '105.5',
      '12.5',
    ]);
    fake.routes.set('/bn/api/v3/klines', () => ({ body: klines }));

    const query = `query($id: ID!, $from: DateTime!, $to: DateTime!) {
      assetCandles(assetId: $id, timeframe: H1, from: $from, to: $to) {
        provider isStale isComplete note candles { openTime close isClosed }
      }
    }`;
    const vars = {
      id: alpha.id,
      from: new Date(start).toISOString(),
      to: new Date(now).toISOString(),
    };

    type Series = {
      assetCandles: {
        provider: string;
        isStale: boolean;
        isComplete: boolean;
        note: string | null;
        candles: { close: string; isClosed: boolean }[];
      };
    };
    const fresh = await gql<Series>(app, query, vars, token);
    expect(fresh.data!.assetCandles).toMatchObject({
      provider: 'binance',
      isStale: false,
      isComplete: true,
    });
    expect(fresh.data!.assetCandles.candles).toHaveLength(5);
    expect(fresh.data!.assetCandles.candles.at(-1)!.isClosed).toBe(false); // current hour still forming
    expect(fresh.data!.assetCandles.candles[0]!.close).toBe('105.5');

    // An hour passes (the forming candle is now old) and the provider is down.
    fake.routes.set('/bn/api/v3/klines', () => ({ status: 500 }));
    await redis.del(`md:candles:refresh:${alpha.id}:H1`);
    await app.get(PrismaService)
      .$executeRaw`UPDATE candles SET fetched_at = now() - interval '1 hour' WHERE asset_id = ${alpha.id}::uuid`;
    const degraded = await gql<Series>(app, query, vars, token);
    expect(degraded.data!.assetCandles).toMatchObject({
      isStale: true,
      provider: 'binance',
    });
    expect(degraded.data!.assetCandles.note).toMatch(/UNAVAILABLE/);
    expect(degraded.data!.assetCandles.candles).toHaveLength(5);
  });

  it('makes one upstream call for many concurrent chart requests', async () => {
    const { alpha } = await ingestTwoCoins();
    const start = Date.now() - 3 * 3_600_000;
    fake.routes.set('/bn/api/v3/klines', () => ({
      body: [
        [Math.floor(start / 3_600_000) * 3_600_000, '1', '1', '1', '1', '1'],
      ],
    }));
    const query = `query($id: ID!, $from: DateTime!, $to: DateTime!) { assetCandles(assetId: $id, timeframe: M15, from: $from, to: $to) { isStale } }`;
    const vars = {
      id: alpha.id,
      from: new Date(start).toISOString(),
      to: new Date().toISOString(),
    };
    await Promise.all(
      Array.from({ length: 10 }, () => gql(app, query, vars, token)),
    );
    expect(fake.hitCount('/bn/api/v3/klines')).toBe(1);
  });

  it('rejects oversized ranges instead of returning a huge payload', async () => {
    const { alpha } = await ingestTwoCoins();
    const res = await gql(
      app,
      `query($id: ID!, $from: DateTime!, $to: DateTime!) { assetCandles(assetId: $id, timeframe: M1, from: $from, to: $to) { isStale } }`,
      {
        id: alpha.id,
        from: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
      token,
    );
    expect(errorCode(res)).toBe('BAD_USER_INPUT');
  });

  it('batches quotes and sparklines: one Redis pipeline and one SQL query for a whole list', async () => {
    await ingestTwoCoins();
    const store = app.get(QuoteStore);
    const prisma = app.get(PrismaService);
    const readMany = jest.spyOn(store, 'readMany');
    const raw = jest.spyOn(prisma, '$queryRaw');

    const res = await gql<{ assets: { nodes: unknown[] } }>(
      app,
      `{ assets(first: 50) { nodes { symbol quote { price } sparkline } } }`,
      {},
      token,
    );

    const count = res.data!.assets.nodes.length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(readMany).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledTimes(1);
    readMany.mockRestore();
    raw.mockRestore();
  });

  it('computes realized volatility from stored hourly candles, and refuses to from thin data', async () => {
    const prisma = app.get(PrismaService);
    const make = (tag: string) =>
      prisma.asset.create({
        data: {
          category: 'CRYPTO',
          symbol: `V${tag}${run}`.toUpperCase(),
          name: `Vol ${tag}`,
          quoteCurrency: 'USD',
        },
      });
    const [swinging, flat, thin] = [
      await make('s'),
      await make('f'),
      await make('t'),
    ];
    const hour = 3_600_000;
    const base = Math.floor(Date.now() / hour) * hour;
    const bars = (
      assetId: string,
      count: number,
      close: (i: number) => number,
    ) =>
      Array.from({ length: count }, (_, i) => {
        const c = close(i);
        return {
          assetId,
          timeframe: 'H1' as const,
          openTime: new Date(base - (count - 1 - i) * hour),
          open: c,
          high: c,
          low: c,
          close: c,
          volume: 1,
          provider: 'test',
          fetchedAt: new Date(),
        };
      });
    await prisma.candle.createMany({
      data: [
        ...bars(swinging.id, 72, (i) => (i % 2 === 0 ? 100 : 110)),
        ...bars(flat.id, 72, () => 100),
        ...bars(thin.id, 6, (i) => 100 + i),
      ],
    });

    type Vol = {
      asset: {
        volatility: {
          annualized24hPct: string | null;
          annualized7dPct: string | null;
          range24hPct: string | null;
          sampleHours: number;
        } | null;
      };
    };
    const query = `query($id: ID!) { asset(id: $id) { volatility { annualized24hPct annualized7dPct range24hPct sampleHours } } }`;
    const get = async (id: string) =>
      (await gql<Vol>(app, query, { id }, token)).data!.asset.volatility;

    const s = await get(swinging.id);
    expect(s).toMatchObject({ range24hPct: '10.00', sampleHours: 71 });
    expect(Number(s!.annualized7dPct)).toBeGreaterThan(0);
    expect(await get(flat.id)).toMatchObject({
      annualized24hPct: '0.00',
      annualized7dPct: '0.00',
      range24hPct: '0.00',
    });
    expect(await get(thin.id)).toMatchObject({
      annualized24hPct: null,
      annualized7dPct: null,
    });
  });
});
