import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AssetCategory } from '../../generated/prisma/enums';
import { REDIS } from '../../infrastructure/redis/redis.module';
import type { StoredQuote } from './market-data.types';

const QUOTE_TTL_SECONDS = 24 * 60 * 60; // dead assets fall out of Redis
const quoteKey = (assetId: string) => `md:quote:${assetId}`;

export type DataQuality = 'LIVE' | 'DELAYED' | 'CACHED' | 'STALE';
export type MarketStatus = 'OPEN' | 'CLOSED' | 'ALWAYS_OPEN';

export const LIVE_MAX_AGE_MS = 30_000;
export const CRYPTO_STALE_AFTER_MS = 10 * 60_000;
/** Stocks refresh every 30 min; two missed refreshes = stale. */
export const STOCK_STALE_AFTER_MS = 2 * 60 * 60_000;

// Freshness is computed when the quote is READ, from its timestamps. A flag
// stored at write time would say "fresh" forever if ingestion stopped.
export function assessQuote(
  quote: StoredQuote,
  category: AssetCategory,
  now: number = Date.now(),
): { isStale: boolean; dataQuality: DataQuality; marketStatus: MarketStatus } {
  if (category === 'CRYPTO') {
    const age = now - Date.parse(quote.sourceTimestamp);
    const isStale = age > CRYPTO_STALE_AFTER_MS;
    const dataQuality: DataQuality = isStale
      ? 'STALE'
      : quote.provider === 'binance-stream' && age <= LIVE_MAX_AGE_MS
        ? 'LIVE'
        : 'CACHED';
    return { isStale, dataQuality, marketStatus: 'ALWAYS_OPEN' };
  }
  // A closed market's last price is current, so stocks go stale when WE stop
  // refreshing (fetchedAt), not when the exchange stops trading.
  const isStale = now - Date.parse(quote.fetchedAt) > STOCK_STALE_AFTER_MS;
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
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

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
