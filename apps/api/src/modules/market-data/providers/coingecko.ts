import type { ProviderHttp } from '../provider-http';
import {
  type ListingRow,
  ProviderError,
  requireDecimal,
  toDecimalString,
} from '../market-data.types';

// Docs: https://docs.coingecko.com/ (public API: no key, ~5-30 calls/min,
// responses cached by CoinGecko for 30-60s, so polling faster is pointless).

type CoinGeckoMarket = {
  id?: unknown;
  symbol?: unknown;
  name?: unknown;
  image?: unknown;
  current_price?: unknown;
  market_cap?: unknown;
  market_cap_rank?: unknown;
  total_volume?: unknown;
  price_change_percentage_24h?: unknown;
  last_updated?: unknown;
};

export type GlobalMarket = {
  totalMarketCapUsd: string | null;
  marketCapChange24hPct: string | null;
  btcDominancePct: string | null;
  sourceTimestamp: Date;
};

export function normalizeMarkets(body: unknown): ListingRow[] {
  if (!Array.isArray(body)) {
    throw new ProviderError(
      'coingecko',
      'BAD_RESPONSE',
      'markets: expected an array',
    );
  }
  const rows: ListingRow[] = [];
  for (const raw of body as CoinGeckoMarket[]) {
    if (
      typeof raw.id !== 'string' ||
      typeof raw.symbol !== 'string' ||
      typeof raw.name !== 'string'
    ) {
      continue; // skip malformed rows, keep the rest
    }
    const updated =
      typeof raw.last_updated === 'string' ? new Date(raw.last_updated) : null;
    if (!updated || Number.isNaN(updated.getTime())) continue;
    rows.push({
      coingeckoId: raw.id,
      symbol: raw.symbol.toUpperCase(),
      name: raw.name,
      logoUrl: typeof raw.image === 'string' ? raw.image : null,
      marketCapRank:
        typeof raw.market_cap_rank === 'number' ? raw.market_cap_rank : null,
      price: requireDecimal(
        'coingecko',
        raw.current_price,
        `current_price of ${raw.id}`,
      ),
      marketCap: toDecimalString(raw.market_cap),
      volume24h: toDecimalString(raw.total_volume),
      change24hPct: toDecimalString(raw.price_change_percentage_24h),
      sourceTimestamp: updated,
    });
  }
  return rows;
}

export function normalizeGlobal(body: unknown): GlobalMarket {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data)
    throw new ProviderError(
      'coingecko',
      'BAD_RESPONSE',
      'global: missing data',
    );
  const caps = data['total_market_cap'] as Record<string, unknown> | undefined;
  const dominance = data['market_cap_percentage'] as
    Record<string, unknown> | undefined;
  const updatedAt = Number(data['updated_at']);
  return {
    totalMarketCapUsd: toDecimalString(caps?.['usd']),
    marketCapChange24hPct: toDecimalString(
      data['market_cap_change_percentage_24h_usd'],
    ),
    btcDominancePct: toDecimalString(dominance?.['btc']),
    sourceTimestamp:
      Number.isFinite(updatedAt) && updatedAt > 0
        ? new Date(updatedAt * 1000)
        : new Date(),
  };
}

export class CoinGeckoAdapter {
  constructor(private readonly http: ProviderHttp) {}

  get health() {
    return this.http.snapshot();
  }

  async topMarkets(size: number): Promise<ListingRow[]> {
    const body = await this.http.getJson<unknown>('/coins/markets', {
      vs_currency: 'usd',
      order: 'market_cap_desc',
      per_page: String(size),
      page: '1',
      price_change_percentage: '24h',
    });
    return normalizeMarkets(body);
  }

  async global(): Promise<GlobalMarket> {
    return normalizeGlobal(await this.http.getJson<unknown>('/global'));
  }
}
