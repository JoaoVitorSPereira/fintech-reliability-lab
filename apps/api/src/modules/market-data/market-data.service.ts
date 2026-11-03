import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Redis } from 'ioredis';
import { type Asset, Prisma } from '../../generated/prisma/client';
import type {
  AssetCategory,
  ChartTimeframe,
} from '../../generated/prisma/enums';
import { isUuid } from '../../graphql/pagination';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { AppError } from '../../shared/errors/app-error';
import { STOCK_UNIVERSE, type StockUniverse } from './market-data.providers';
import {
  type CandleBar,
  type CandleProvider,
  ProviderError,
  TIMEFRAME_MS,
} from './market-data.types';
import { BinanceAdapter } from './providers/binance';
import { CoinGeckoAdapter } from './providers/coingecko';
import { TwelveDataAdapter } from './providers/twelve-data';
import { QuoteStore, assessQuote } from './quote-store';

export const MAX_CANDLES = 1000;
export const OVERVIEW_KEY = 'md:overview';

export type AssetSort = 'MARKET_CAP' | 'PRICE' | 'CHANGE_24H' | 'VOLUME';

export type CandleSeries = {
  assetId: string;
  timeframe: ChartTimeframe;
  provider: string | null;
  candles: (CandleBar & { isClosed: boolean })[];
  /** True when the provider couldn't be reached and only stored candles are returned. */
  isStale: boolean;
  /** False when the stored range has gaps (missing intervals are never invented). */
  isComplete: boolean;
  note: string | null;
};

@Injectable()
export class MarketDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: QuoteStore,
    private readonly binance: BinanceAdapter,
    private readonly twelveData: TwelveDataAdapter,
    private readonly coingecko: CoinGeckoAdapter,
    @Inject(STOCK_UNIVERSE) private readonly stocks: StockUniverse,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectPinoLogger(MarketDataService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** Provider registry: which adapter serves candles for this asset, if any. */
  candleProviderFor(
    asset: Asset,
  ): { provider: CandleProvider; symbol: string } | null {
    if (asset.binanceSymbol)
      return { provider: this.binance, symbol: asset.binanceSymbol };
    if (asset.twelveDataSymbol)
      return { provider: this.twelveData, symbol: asset.twelveDataSymbol };
    return null;
  }

  async getAsset(id: string): Promise<Asset> {
    const asset = isUuid(id)
      ? await this.prisma.asset.findUnique({ where: { id } })
      : null;
    if (!asset) throw new AppError('NOT_FOUND', 'Asset not found.');
    return asset;
  }

  // ponytail: sorts in memory. The tracked universe is bounded (~25 crypto +
  // a few stocks), so this is one query + one Redis pipeline. Move the sort
  // keys into Postgres if the universe ever reaches thousands.
  async listAssets(filter: {
    category?: AssetCategory | null;
    search?: string | null;
    sort: AssetSort;
  }): Promise<Asset[]> {
    const search = filter.search?.trim();
    const assets = await this.prisma.asset.findMany({
      where: {
        ...(filter.category && { category: filter.category }),
        ...(search && {
          OR: [
            { symbol: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: [
        { marketCapRank: { sort: 'asc', nulls: 'last' } },
        { symbol: 'asc' },
      ],
    });
    if (filter.sort === 'MARKET_CAP') return assets;

    const quotes = await this.quotes.readMany(assets.map((asset) => asset.id));
    const key = (asset: Asset): Prisma.Decimal | null => {
      const quote = quotes.get(asset.id);
      const value =
        filter.sort === 'PRICE'
          ? quote?.price
          : filter.sort === 'CHANGE_24H'
            ? quote?.change24hPct
            : quote?.volume24h;
      return value ? new Prisma.Decimal(value) : null;
    };
    // Descending; assets without data go last.
    return [...assets].sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      if (!x || !y) return x ? -1 : y ? 1 : 0;
      return y.comparedTo(x);
    });
  }

  async candles(
    assetId: string,
    timeframe: ChartTimeframe,
    from: Date,
    to: Date,
  ): Promise<CandleSeries> {
    const asset = await this.getAsset(assetId);
    const step = TIMEFRAME_MS[timeframe];
    if (!(from < to))
      throw new AppError('BAD_USER_INPUT', '`from` must be before `to`.');
    const end = new Date(Math.min(to.getTime(), Date.now()));
    if ((end.getTime() - from.getTime()) / step > MAX_CANDLES) {
      throw new AppError(
        'BAD_USER_INPUT',
        `Range too large: at most ${MAX_CANDLES} candles per request. Use a larger timeframe.`,
      );
    }

    const source = this.candleProviderFor(asset);
    if (!source || !source.provider.timeframes.has(timeframe)) {
      // Never fabricate intervals a provider doesn't offer.
      return {
        assetId,
        timeframe,
        provider: null,
        candles: [],
        isStale: false,
        isComplete: false,
        note: 'No provider offers candles for this asset and timeframe.',
      };
    }

    let isStale = false;
    let note: string | null = null;
    let stored = await this.readCandles(asset.id, timeframe, from, end);
    if (
      this.needsRefresh(stored, from, end, step) &&
      (await this.claimRefresh(asset.id, timeframe, step))
    ) {
      try {
        const bars = await source.provider.fetchCandles(
          source.symbol,
          timeframe,
          from,
          end,
        );
        await this.upsertCandles(
          asset.id,
          timeframe,
          source.provider.name,
          bars,
        );
        stored = await this.readCandles(asset.id, timeframe, from, end);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        // Graceful degradation: serve what we have, and say so.
        isStale = true;
        note = `Provider unavailable (${error.kind}); showing stored candles.`;
        this.logger.warn(
          { provider: error.provider, kind: error.kind, assetId },
          'candle refresh failed',
        );
      }
    }

    const now = Date.now();
    return {
      assetId,
      timeframe,
      provider: source.provider.name,
      candles: stored.map(({ fetchedAt: _fetchedAt, ...bar }) => ({
        ...bar,
        isClosed: bar.openTime.getTime() + step <= now,
      })),
      isStale,
      // Exchange sessions (nights, weekends, holidays) make stock gaps normal,
      // so gap detection only applies to 24/7 crypto markets.
      isComplete:
        asset.category !== 'CRYPTO' || !hasGaps(stored, step, timeframe),
      note,
    };
  }

  async overview() {
    const stats = await this.redis
      .hgetall(OVERVIEW_KEY)
      .catch(() => ({}) as Record<string, string>);
    const crypto = await this.prisma.asset.findMany({
      where: { category: 'CRYPTO' },
    });
    const quotes = await this.quotes.readMany(crypto.map((asset) => asset.id));
    // Movers only from fresh quotes: a stale +40% is not a "top gainer".
    const fresh = crypto.filter((asset) => {
      const quote = quotes.get(asset.id);
      return quote && !assessQuote(quote, 'CRYPTO').isStale;
    });
    const by = (field: 'change24hPct' | 'volume24h') => (a: Asset, b: Asset) =>
      new Prisma.Decimal(quotes.get(b.id)?.[field] ?? 0).comparedTo(
        quotes.get(a.id)?.[field] ?? 0,
      );
    const byChange = fresh
      .filter((asset) => quotes.get(asset.id)?.change24hPct != null)
      .sort(by('change24hPct'));
    const indexProxies = await this.prisma.asset.findMany({
      where: { category: 'ETF', symbol: { in: ['SPY', 'QQQ'] } },
    });

    return {
      totalMarketCapUsd: stats['totalMarketCapUsd'] ?? null,
      marketCapChange24hPct: stats['marketCapChange24hPct'] ?? null,
      btcDominancePct: stats['btcDominancePct'] ?? null,
      asOf: stats['sourceTimestamp']
        ? new Date(stats['sourceTimestamp'])
        : null,
      topGainers: byChange.slice(0, 5),
      topLosers: byChange.slice(-5).reverse(),
      mostTraded: [...fresh].sort(by('volume24h')).slice(0, 5),
      indexProxies,
    };
  }

  providerStatus() {
    return [
      this.coingecko.health,
      this.binance.health,
      this.twelveData.health,
    ].map((health) => ({
      ...health,
      note:
        health.name === 'twelve-data' && this.stocks.limited
          ? 'No TWELVE_DATA_API_KEY: using the public demo key (AAPL only).'
          : null,
    }));
  }

  async upsertCandles(
    assetId: string,
    timeframe: ChartTimeframe,
    provider: string,
    bars: CandleBar[],
  ) {
    if (bars.length === 0) return;
    const fetchedAt = new Date();
    // One statement per batch. In-progress candles are overwritten on the
    // next fetch; closed ones converge to the provider's final values.
    const rows = bars.map(
      (
        bar,
      ) => Prisma.sql`(${assetId}::uuid, ${timeframe}::chart_timeframe, ${bar.openTime}, ${bar.open}::numeric,
        ${bar.high}::numeric, ${bar.low}::numeric, ${bar.close}::numeric, ${bar.volume}::numeric, ${provider}, ${fetchedAt})`,
    );
    await this.prisma.$executeRaw`
      INSERT INTO candles (asset_id, timeframe, open_time, open, high, low, close, volume, provider, fetched_at)
      VALUES ${Prisma.join(rows)}
      ON CONFLICT (asset_id, timeframe, open_time) DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
        volume = EXCLUDED.volume, provider = EXCLUDED.provider, fetched_at = EXCLUDED.fetched_at`;
  }

  private async readCandles(
    assetId: string,
    timeframe: ChartTimeframe,
    from: Date,
    to: Date,
  ): Promise<(CandleBar & { fetchedAt: Date })[]> {
    const rows = await this.prisma.candle.findMany({
      where: { assetId, timeframe, openTime: { gte: from, lte: to } },
      orderBy: { openTime: 'asc' },
      take: MAX_CANDLES + 1,
    });
    return rows.map((row) => ({
      openTime: row.openTime,
      open: row.open.toFixed(),
      high: row.high.toFixed(),
      low: row.low.toFixed(),
      close: row.close.toFixed(),
      volume: row.volume.toFixed(),
      fetchedAt: row.fetchedAt,
    }));
  }

  // Refresh when nothing is stored, the newest candle is behind, or the
  // newest candle is still forming and was fetched a while ago. Older gaps
  // are fetched once, then the cooldown stops repeat attempts.
  private needsRefresh(
    stored: (CandleBar & { fetchedAt: Date })[],
    from: Date,
    to: Date,
    step: number,
  ): boolean {
    const first = stored.at(0);
    const last = stored.at(-1);
    if (!first || !last) return true;
    const now = Date.now();
    const lastIsForming = last.openTime.getTime() + step > now;
    return (
      last.openTime.getTime() < to.getTime() - step ||
      first.openTime.getTime() > from.getTime() + step ||
      (lastIsForming &&
        now - last.fetchedAt.getTime() > refreshCooldownMs(step))
    );
  }

  // At most one provider fetch per asset+timeframe per cooldown, across all
  // instances: a chart opened by 1,000 users is one upstream call, not 1,000.
  private async claimRefresh(
    assetId: string,
    timeframe: ChartTimeframe,
    step: number,
  ): Promise<boolean> {
    const claimed = await this.redis
      .set(
        `md:candles:refresh:${assetId}:${timeframe}`,
        '1',
        'PX',
        refreshCooldownMs(step),
        'NX',
      )
      .catch(() => 'OK'); // Redis down: allow; provider budget still applies
    return claimed === 'OK';
  }
}

/** 15s for 1-minute bars, a quarter interval in between, at most 15 min. */
function refreshCooldownMs(step: number): number {
  return Math.min(Math.max(step / 4, 15_000), 15 * 60_000);
}

// A gap = consecutive bars further apart than one interval (with slack for
// month lengths). Gaps are reported, never filled with invented bars.
function hasGaps(
  bars: CandleBar[],
  step: number,
  timeframe: ChartTimeframe,
): boolean {
  const tolerance = timeframe === 'MN1' ? step : step * 1.5;
  for (let i = 1; i < bars.length; i++) {
    if (
      bars[i]!.openTime.getTime() - bars[i - 1]!.openTime.getTime() >
      tolerance
    )
      return true;
  }
  return false;
}
