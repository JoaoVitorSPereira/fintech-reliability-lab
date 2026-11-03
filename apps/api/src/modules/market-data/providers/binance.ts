import { Prisma } from '../../../generated/prisma/client';
import type { ChartTimeframe } from '../../../generated/prisma/enums';
import type { ProviderHttp } from '../provider-http';
import {
  type CandleBar,
  type CandleProvider,
  ProviderError,
  TIMEFRAME_MS,
  requireDecimal,
} from '../market-data.types';

// Docs: https://developers.binance.com/docs/binance-spot-api-docs
// data-api.binance.vision / data-stream.binance.vision are Binance's
// market-data-only endpoints (no account features, no key). Prices are in
// USDT, a stablecoin, not USD: see ADR 0007 for how that's handled.

const INTERVAL: Record<ChartTimeframe, string> = {
  M1: '1m',
  M5: '5m',
  M15: '15m',
  H1: '1h',
  H4: '4h',
  D1: '1d',
  W1: '1w',
  MN1: '1M',
};
const MAX_KLINES = 1000;

export function normalizeKlines(body: unknown): CandleBar[] {
  if (!Array.isArray(body)) {
    throw new ProviderError(
      'binance',
      'BAD_RESPONSE',
      'klines: expected an array',
    );
  }
  return body.map((row: unknown) => {
    if (!Array.isArray(row) || typeof row[0] !== 'number') {
      throw new ProviderError(
        'binance',
        'BAD_RESPONSE',
        'klines: malformed row',
      );
    }
    return {
      openTime: new Date(row[0]),
      open: requireDecimal('binance', row[1], 'open'),
      high: requireDecimal('binance', row[2], 'high'),
      low: requireDecimal('binance', row[3], 'low'),
      close: requireDecimal('binance', row[4], 'close'),
      volume: requireDecimal('binance', row[5], 'volume'),
    };
  });
}

/** 24h rolling ticker from the miniTicker stream ("e":"24hrMiniTicker"). */
export type MiniTicker = {
  symbol: string;
  price: string;
  change24hPct: string | null;
  quoteVolume24h: string;
  eventTime: Date;
};

export function normalizeMiniTicker(message: unknown): MiniTicker | null {
  const data =
    (message as { data?: Record<string, unknown> } | null)?.data ?? message;
  if (!data || typeof data !== 'object') return null;
  const event = data as Record<string, unknown>;
  if (event['e'] !== '24hrMiniTicker' || typeof event['s'] !== 'string')
    return null;
  const close = new Prisma.Decimal(String(event['c']));
  const open = new Prisma.Decimal(String(event['o']));
  return {
    symbol: event['s'],
    price: close.toFixed(),
    change24hPct: open.isZero()
      ? null
      : close.minus(open).div(open).times(100).toDecimalPlaces(4).toFixed(),
    quoteVolume24h: new Prisma.Decimal(String(event['q'])).toFixed(),
    eventTime: new Date(Number(event['E'])),
  };
}

export class BinanceAdapter implements CandleProvider {
  readonly name = 'binance' as const;
  readonly timeframes: ReadonlySet<ChartTimeframe> = new Set(
    Object.keys(INTERVAL) as ChartTimeframe[],
  );

  constructor(private readonly http: ProviderHttp) {}

  get health() {
    return this.http.snapshot();
  }

  async fetchCandles(
    symbol: string,
    timeframe: ChartTimeframe,
    from: Date,
    to: Date,
  ): Promise<CandleBar[]> {
    const limit = Math.min(
      MAX_KLINES,
      Math.ceil((to.getTime() - from.getTime()) / TIMEFRAME_MS[timeframe]) + 1,
    );
    const body = await this.http.getJson<unknown>('/api/v3/klines', {
      symbol,
      interval: INTERVAL[timeframe],
      startTime: String(from.getTime()),
      endTime: String(to.getTime()),
      limit: String(limit),
    });
    return normalizeKlines(body);
  }

  /** All spot symbols currently listed, e.g. "BTCUSDT". One call, weight 4. */
  async listedSymbols(): Promise<Set<string>> {
    const body = await this.http.getJson<unknown>('/api/v3/ticker/price');
    if (!Array.isArray(body))
      throw this.http.badResponse('ticker/price: expected an array');
    return new Set(
      body
        .map((row: unknown) => (row as { symbol?: unknown }).symbol)
        .filter((symbol): symbol is string => typeof symbol === 'string'),
    );
  }
}
