import { ChartTimeframe } from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';

export type ProviderName = 'coingecko' | 'binance' | 'twelve-data';

/** Provider-agnostic listing row (what an adapter's normalizer returns). */
export type ListingRow = {
  coingeckoId: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  marketCapRank: number | null;
  price: string;
  marketCap: string | null;
  volume24h: string | null;
  change24hPct: string | null;
  sourceTimestamp: Date;
};

/**
 * Current price snapshot as stored in Redis. Timestamps are ISO strings.
 * Freshness is computed at READ time from these timestamps, never stored.
 */
export type StoredQuote = {
  assetId: string;
  price: string;
  currency: string;
  change24hPct: string | null;
  volume24h: string | null;
  marketCap: string | null;
  provider: string;
  /** When the provider says the price was true. */
  sourceTimestamp: string;
  /** When we received it. */
  fetchedAt: string;
  /** Exchange session state where it applies (stocks). Null for 24/7 markets. */
  marketOpen: boolean | null;
};

export type CandleBar = {
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

/** Two adapters implement this (Binance, Twelve Data); the registry picks one per asset. */
export interface CandleProvider {
  readonly name: ProviderName;
  readonly timeframes: ReadonlySet<ChartTimeframe>;
  fetchCandles(
    providerSymbol: string,
    timeframe: ChartTimeframe,
    from: Date,
    to: Date,
  ): Promise<CandleBar[]>;
}

export type ProviderErrorKind =
  | 'RATE_LIMITED'
  | 'BUDGET_EXHAUSTED'
  | 'CIRCUIT_OPEN'
  | 'UNAVAILABLE'
  | 'BAD_RESPONSE'
  | 'NOT_CONFIGURED';

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

export const TIMEFRAME_MS: Record<ChartTimeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
  // Calendar months vary; 31 days is only used for sizing and gap detection.
  MN1: 31 * 24 * 60 * 60_000,
};

// Providers send JSON numbers (CoinGecko) or strings (Binance, Twelve Data).
// Numbers are converted once, here, to their shortest exact decimal string
// (no exponent notation: 1.2e-7 becomes "0.00000012"). No arithmetic ever
// happens on the float.
export function toDecimalString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() ? decimal.toFixed() : null;
  } catch {
    return null;
  }
}

export function requireDecimal(
  provider: ProviderName,
  value: unknown,
  field: string,
): string {
  const decimal = toDecimalString(value);
  if (decimal === null) {
    throw new ProviderError(
      provider,
      'BAD_RESPONSE',
      `missing or invalid ${field}`,
    );
  }
  return decimal;
}
