import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AssetCategory } from '../../generated/prisma/enums';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { REDIS } from '../../infrastructure/redis/redis.module';
import type { StoredQuote } from './market-data.types';

const QUOTE_TTL_SECONDS = 24 * 60 * 60; // dead assets fall out of Redis
const quoteKey = (assetId: string) => `md:quote:${assetId}`;

export type DataQuality = 'LIVE' | 'DELAYED' | 'CACHED' | 'STALE';
export type MarketStatus = 'OPEN' | 'CLOSED' | 'ALWAYS_OPEN';

/** Freshness windows. Defaults below; production values come from env (see Env). */
export type FreshnessPolicy = {
  liveMaxAgeMs: number;
  cryptoStaleAfterMs: number;
  /** Stocks refresh every 30 min by default; two missed refreshes = stale. */
  stockStaleAfterMs: number;
  /** A simulated crypto fill needs a price at most this old. */
  tradeMaxPriceAgeMs: number;
};

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  liveMaxAgeMs: 30_000,
  cryptoStaleAfterMs: 10 * 60_000,
  stockStaleAfterMs: 2 * 60 * 60_000,
  tradeMaxPriceAgeMs: 60_000,
};

// Freshness is computed when the quote is READ, from its timestamps. A flag
// stored at write time would say "fresh" forever if ingestion stopped.
export function assessQuote(
  quote: StoredQuote,
  category: AssetCategory,
  now: number = Date.now(),
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
): { isStale: boolean; dataQuality: DataQuality; marketStatus: MarketStatus } {
  if (category === 'CRYPTO') {
    const age = now - Date.parse(quote.sourceTimestamp);
    const isStale = age > policy.cryptoStaleAfterMs;
    const dataQuality: DataQuality = isStale
      ? 'STALE'
      : quote.provider === 'binance-stream' && age <= policy.liveMaxAgeMs
        ? 'LIVE'
        : 'CACHED';
    return { isStale, dataQuality, marketStatus: 'ALWAYS_OPEN' };
  }
  // A closed market's last price is current, so stocks go stale when WE stop
  // refreshing (fetchedAt), not when the exchange stops trading.
  const isStale = now - Date.parse(quote.fetchedAt) > policy.stockStaleAfterMs;
  return {
    isStale,
    dataQuality: isStale ? 'STALE' : 'DELAYED',
    marketStatus: quote.marketOpen ? 'OPEN' : 'CLOSED',
  };
}

// Quotes are Redis hashes so different sources can update different fields
// (CoinGecko: market cap; Binance stream: price) without overwriting each other.
@Injectable()
export class QuoteStore {
  readonly freshness: FreshnessPolicy;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    const seconds = (
      key:
        | 'QUOTE_LIVE_MAX_AGE_SECONDS'
        | 'CRYPTO_QUOTE_STALE_AFTER_SECONDS'
        | 'STOCK_QUOTE_STALE_AFTER_SECONDS'
        | 'TRADE_MAX_PRICE_AGE_SECONDS',
    ) => config.get(key, { infer: true }) * 1000;
    this.freshness = {
      liveMaxAgeMs: seconds('QUOTE_LIVE_MAX_AGE_SECONDS'),
      cryptoStaleAfterMs: seconds('CRYPTO_QUOTE_STALE_AFTER_SECONDS'),
      stockStaleAfterMs: seconds('STOCK_QUOTE_STALE_AFTER_SECONDS'),
      tradeMaxPriceAgeMs: seconds('TRADE_MAX_PRICE_AGE_SECONDS'),
    };
  }

  /** assessQuote with this deployment's configured windows. */
  assess(
    quote: StoredQuote,
    category: AssetCategory,
    now: number = Date.now(),
  ) {
    return assessQuote(quote, category, now, this.freshness);
  }

  async write(
    quotes: (Partial<StoredQuote> & { assetId: string })[],
  ): Promise<void> {
    if (quotes.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const quote of quotes) {
      const fields: Record<string, string> = {};
      for (const [field, value] of Object.entries(quote)) {
        if (value !== undefined) fields[field] = JSON.stringify(value);
      }
      pipeline.hset(quoteKey(quote.assetId), fields);
      pipeline.expire(quoteKey(quote.assetId), QUOTE_TTL_SECONDS);
    }
    await pipeline.exec();
  }

  /** One round trip for any number of assets (the DataLoader batches into this). */
  async readMany(
    assetIds: readonly string[],
  ): Promise<Map<string, StoredQuote>> {
    const result = new Map<string, StoredQuote>();
    if (assetIds.length === 0) return result;
    const pipeline = this.redis.pipeline();
    for (const id of assetIds) pipeline.hgetall(quoteKey(id));
    const replies = (await pipeline.exec()) ?? [];
    replies.forEach(([error, hash], index) => {
      const quote = error ? null : parseQuote(hash as Record<string, string>);
      if (quote) result.set(assetIds[index]!, quote);
    });
    return result;
  }
}

function parseQuote(hash: Record<string, string>): StoredQuote | null {
  if (!hash['price'] || !hash['sourceTimestamp']) return null;
  const read = (field: string): unknown =>
    hash[field] === undefined ? null : JSON.parse(hash[field]);
  return {
    assetId: read('assetId') as string,
    price: read('price') as string,
    currency: read('currency') as string,
    change24hPct: read('change24hPct') as string | null,
    volume24h: read('volume24h') as string | null,
    marketCap: read('marketCap') as string | null,
    provider: read('provider') as string,
    sourceTimestamp: read('sourceTimestamp') as string,
    fetchedAt: read('fetchedAt') as string,
    marketOpen: read('marketOpen') as boolean | null,
  };
}
