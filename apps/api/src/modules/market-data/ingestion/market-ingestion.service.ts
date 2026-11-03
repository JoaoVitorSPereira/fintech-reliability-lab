import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { REDIS } from '../../../infrastructure/redis/redis.module';
import {
  KNOWN_ETFS,
  STOCK_UNIVERSE,
  type StockUniverse,
} from '../market-data.providers';
import { MarketDataService, OVERVIEW_KEY } from '../market-data.service';
import { ProviderError } from '../market-data.types';
import { BinanceAdapter, type MiniTicker } from '../providers/binance';
import { CoinGeckoAdapter } from '../providers/coingecko';
import { TwelveDataAdapter } from '../providers/twelve-data';
import { LIVE_MAX_AGE_MS, QuoteStore } from '../quote-store';
import { BinanceStream } from './binance-stream';
import { JobRunner } from './job-runner';

export const PRICE_CHANNEL = 'md:prices';
const PUBLISH_EVERY_MS = 1_000; // per asset: at most one fan-out per second
const MINUTE = 60_000;

export type PriceUpdateMessage = {
  assetId: string;
  price: string;
  change24hPct: string | null;
  sourceTimestamp: string;
};

@Injectable()
export class MarketIngestionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly runner: JobRunner;
  private stream: BinanceStream | null = null;
  private assetIdByBinanceSymbol = new Map<string, string>();
  private readonly lastPublished = new Map<string, number>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly quotes: QuoteStore,
    private readonly marketData: MarketDataService,
    private readonly coingecko: CoinGeckoAdapter,
    private readonly binance: BinanceAdapter,
    private readonly twelveData: TwelveDataAdapter,
    @Inject(STOCK_UNIVERSE) private readonly stocks: StockUniverse,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectPinoLogger(MarketIngestionService.name)
    private readonly logger: PinoLogger,
  ) {
    this.runner = new JobRunner(redis);
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('MARKET_INGESTION_ENABLED', { infer: true })) return;
    this.stream = new BinanceStream(
      this.config.get('BINANCE_WS_URL', { infer: true }),
      (ticker) => void this.onTicker(ticker).catch(() => undefined),
    );
    this.runner.schedule({
      name: 'crypto-listings',
      everyMs: 5 * MINUTE,
      initialDelayMs: 1_000,
      run: () => this.syncCryptoListings(),
    });
    this.runner.schedule({
      name: 'stock-quotes',
      everyMs: 30 * MINUTE,
      initialDelayMs: 5_000,
      run: () => this.syncStockQuotes(),
    });
    this.runner.schedule({
      name: 'crypto-hourly-candles',
      everyMs: 60 * MINUTE,
      initialDelayMs: 20_000,
      run: () => this.syncHourlyCandles('CRYPTO'),
    });
    this.runner.schedule({
      name: 'stock-hourly-candles',
      everyMs: 180 * MINUTE,
      initialDelayMs: 90_000,
      run: () => this.syncHourlyCandles('STOCK'),
    });
    this.logger.info('market ingestion started');
  }

  onApplicationShutdown(): void {
    this.runner.stop();
    this.stream?.stop();
  }

  get streamConnected(): boolean {
    return this.stream?.connected ?? false;
  }

  /** CoinGecko top-N + Binance symbol list → assets, quotes, overview. */
  async syncCryptoListings(): Promise<string> {
    const size = this.config.get('CRYPTO_LISTING_SIZE', { infer: true });
    const [listings, binanceSymbols] = await Promise.all([
      this.coingecko.topMarkets(size),
      // Binance being down must not block listings; we just won't stream.
      this.binance.listedSymbols().catch(() => new Set<string>()),
    ]);

    const now = new Date();
    const existing = await this.quotes.readMany(
      (
        await this.prisma.asset.findMany({
          where: { category: 'CRYPTO' },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    const seenSymbols = new Set<string>();
    const writes = [];
    for (const row of listings) {
      if (seenSymbols.has(row.symbol)) continue; // duplicate tickers: keep the higher-ranked one
      seenSymbols.add(row.symbol);
      const pair = `${row.symbol}USDT`;
      const binanceSymbol =
        row.symbol !== 'USDT' && binanceSymbols.has(pair) ? pair : null;
      const asset = await this.prisma.asset.upsert({
        where: { coingeckoId: row.coingeckoId },
        create: {
          category: 'CRYPTO',
          symbol: row.symbol,
          name: row.name,
          quoteCurrency: 'USD',
          logoUrl: row.logoUrl,
          marketCapRank: row.marketCapRank,
          coingeckoId: row.coingeckoId,
          binanceSymbol,
        },
        update: {
          name: row.name,
          logoUrl: row.logoUrl,
          marketCapRank: row.marketCapRank,
          // keep a known pair if Binance's list was unavailable this run
          ...(binanceSymbols.size > 0 && { binanceSymbol }),
        },
      });
      // Don't overwrite a live streamed price with a ~1 min old polled one.
      const current = existing.get(asset.id);
      const streamIsLive =
        current?.provider === 'binance-stream' &&
        now.getTime() - Date.parse(current.sourceTimestamp) < LIVE_MAX_AGE_MS;
      writes.push({
        assetId: asset.id,
        marketCap: row.marketCap,
        ...(!streamIsLive && {
          price: row.price,
          currency: 'USD',
          change24hPct: row.change24hPct,
          volume24h: row.volume24h,
          provider: 'coingecko',
          sourceTimestamp: row.sourceTimestamp.toISOString(),
          fetchedAt: now.toISOString(),
          marketOpen: null,
        }),
      });
    }
    await this.quotes.write(writes);

    const global = await this.coingecko.global().catch(() => null);
    if (global) {
      const fields: Record<string, string> = {
        sourceTimestamp: global.sourceTimestamp.toISOString(),
      };
      if (global.totalMarketCapUsd)
        fields['totalMarketCapUsd'] = global.totalMarketCapUsd;
      if (global.marketCapChange24hPct)
        fields['marketCapChange24hPct'] = global.marketCapChange24hPct;
      if (global.btcDominancePct)
        fields['btcDominancePct'] = global.btcDominancePct;
      await this.redis.hset(OVERVIEW_KEY, fields);
    }

    await this.refreshStreamSymbols();
    return `${writes.length} assets, ${this.assetIdByBinanceSymbol.size} streamed`;
  }

  async syncStockQuotes(): Promise<string> {
    let updated = 0;
    for (const symbol of this.stocks.symbols) {
      try {
        const quote = await this.twelveData.quote(symbol);
        const asset = await this.prisma.asset.upsert({
          where: { twelveDataSymbol: symbol },
          create: {
            category: KNOWN_ETFS.has(symbol) ? 'ETF' : 'STOCK',
            symbol,
            name: quote.name,
            quoteCurrency: 'USD',
            twelveDataSymbol: symbol,
          },
          update: { name: quote.name },
        });
        await this.quotes.write([
          {
            assetId: asset.id,
            price: quote.price,
            currency: 'USD',
            change24hPct: quote.change24hPct,
            volume24h: quote.volume,
            marketCap: null,
            provider: 'twelve-data',
            sourceTimestamp: quote.sourceTimestamp.toISOString(),
            fetchedAt: new Date().toISOString(),
            marketOpen: quote.marketOpen,
          },
        ]);
        updated++;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        // Out of budget or rate limited: stop now, the next run continues.
        if (error.kind !== 'BAD_RESPONSE' && error.kind !== 'NOT_CONFIGURED')
          break;
        this.logger.warn({ symbol, kind: error.kind }, 'stock quote skipped');
      }
    }
    return `${updated}/${this.stocks.symbols.length} stocks`;
  }

  /** Keeps 48h of hourly candles warm for sparklines and the default chart. */
  async syncHourlyCandles(kind: 'CRYPTO' | 'STOCK'): Promise<string> {
    const assets = await this.prisma.asset.findMany({
      where:
        kind === 'CRYPTO'
          ? { binanceSymbol: { not: null } }
          : { twelveDataSymbol: { not: null } },
    });
    const to = new Date();
    const from = new Date(
      to.getTime() - (kind === 'CRYPTO' ? 48 : 24 * 5) * 60 * MINUTE,
    );
    let synced = 0;
    for (const asset of assets) {
      const source = this.marketData.candleProviderFor(asset);
      if (!source) continue;
      try {
        const bars = await source.provider.fetchCandles(
          source.symbol,
          'H1',
          from,
          to,
        );
        await this.marketData.upsertCandles(
          asset.id,
          'H1',
          source.provider.name,
          bars,
        );
        synced++;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (
          error.kind === 'BUDGET_EXHAUSTED' ||
          error.kind === 'RATE_LIMITED' ||
          error.kind === 'CIRCUIT_OPEN'
        )
          break;
      }
    }
    return `${synced}/${assets.length} assets`;
  }

  private async refreshStreamSymbols(): Promise<void> {
    const streamed = await this.prisma.asset.findMany({
      where: { binanceSymbol: { not: null } },
      select: { id: true, binanceSymbol: true },
    });
    this.assetIdByBinanceSymbol = new Map(
      streamed.map((a) => [a.binanceSymbol!, a.id]),
    );
    this.stream?.track([...this.assetIdByBinanceSymbol.keys()]);
  }

  private async onTicker(ticker: MiniTicker): Promise<void> {
    const assetId = this.assetIdByBinanceSymbol.get(ticker.symbol);
    if (!assetId) return;
    const sourceTimestamp = ticker.eventTime.toISOString();
    // Volume stays CoinGecko's (all exchanges). Binance-only volume would make
    // "most traded" compare one exchange against the whole market.
    await this.quotes.write([
      {
        assetId,
        price: ticker.price,
        currency: 'USDT',
        change24hPct: ticker.change24hPct,
        provider: 'binance-stream',
        sourceTimestamp,
        fetchedAt: new Date().toISOString(),
        marketOpen: null,
      },
    ]);
    // Ticks arrive every second per symbol; subscribers get at most one per
    // asset per second (the stream itself is already ~1/s, this caps bursts).
    const now = Date.now();
    if (now - (this.lastPublished.get(assetId) ?? 0) < PUBLISH_EVERY_MS) return;
    this.lastPublished.set(assetId, now);
    const message: PriceUpdateMessage = {
      assetId,
      price: ticker.price,
      change24hPct: ticker.change24hPct,
      sourceTimestamp,
    };
    await this.redis.publish(PRICE_CHANNEL, JSON.stringify(message));
  }
}
