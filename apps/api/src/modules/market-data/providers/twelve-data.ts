import type { ChartTimeframe } from '../../../generated/prisma/enums';
import type { ProviderHttp } from '../provider-http';
import {
  type CandleBar,
  type CandleProvider,
  ProviderError,
  requireDecimal,
  toDecimalString,
} from '../market-data.types';

// Docs: https://twelvedata.com/docs. Free plan: 8 credits/minute, 800/day,
// one credit per symbol. The "demo" key only covers a few symbols (AAPL).
// We label all stock prices DELAYED: we can't verify the plan's latency.

const INTERVAL: Record<ChartTimeframe, string> = {
  M1: '1min',
  M5: '5min',
  M15: '15min',
  H1: '1h',
  H4: '4h',
  D1: '1day',
  W1: '1week',
  MN1: '1month',
};

export type StockQuote = {
  symbol: string;
  name: string;
  price: string;
  change24hPct: string | null;
  volume: string | null;
  marketOpen: boolean;
  sourceTimestamp: Date;
};

function assertOk(body: unknown, what: string): Record<string, unknown> {
  const record = body as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    throw new ProviderError(
      'twelve-data',
      'BAD_RESPONSE',
      `${what}: not an object`,
    );
  }
  // Twelve Data reports errors with HTTP 200 and {"status":"error","code":...}.
  if (record['status'] === 'error') {
    const code = Number(record['code']);
    const kind =
      code === 429
        ? 'RATE_LIMITED'
        : code === 401 || code === 403
          ? 'NOT_CONFIGURED'
          : 'BAD_RESPONSE';
    throw new ProviderError('twelve-data', kind, `${what}: error ${code}`);
  }
  return record;
}

export function normalizeQuote(body: unknown): StockQuote {
  const quote = assertOk(body, 'quote');
  const at = Number(quote['last_quote_at'] ?? quote['timestamp']);
  return {
    symbol: String(quote['symbol']),
    name: String(quote['name'] ?? quote['symbol']),
    price: requireDecimal('twelve-data', quote['close'], 'close'),
    change24hPct: toDecimalString(quote['percent_change']),
    volume: toDecimalString(quote['volume']),
    marketOpen: quote['is_market_open'] === true,
    sourceTimestamp:
      Number.isFinite(at) && at > 0 ? new Date(at * 1000) : new Date(),
  };
}

// Requested with timezone=UTC. Intraday datetimes are "YYYY-MM-DD HH:mm:ss";
// daily and longer are a bare date, stored as that date at 00:00 UTC.
export function normalizeTimeSeries(body: unknown): CandleBar[] {
  const series = assertOk(body, 'time_series');
  const values = series['values'];
  if (!Array.isArray(values)) {
    throw new ProviderError(
      'twelve-data',
      'BAD_RESPONSE',
      'time_series: missing values',
    );
  }
  return values
    .map((raw: Record<string, unknown>) => {
      const datetime = String(raw['datetime']);
      const iso =
        datetime.length === 10
          ? `${datetime}T00:00:00Z`
          : `${datetime.replace(' ', 'T')}Z`;
      return {
        openTime: new Date(iso),
        open: requireDecimal('twelve-data', raw['open'], 'open'),
        high: requireDecimal('twelve-data', raw['high'], 'high'),
        low: requireDecimal('twelve-data', raw['low'], 'low'),
        close: requireDecimal('twelve-data', raw['close'], 'close'),
        volume: toDecimalString(raw['volume']) ?? '0',
      };
    })
    .filter((bar) => !Number.isNaN(bar.openTime.getTime()))
    .reverse(); // provider sends newest first
}

function utcDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export class TwelveDataAdapter implements CandleProvider {
  readonly name = 'twelve-data' as const;
  readonly timeframes: ReadonlySet<ChartTimeframe> = new Set(
    Object.keys(INTERVAL) as ChartTimeframe[],
  );

  constructor(private readonly http: ProviderHttp) {}

  get health() {
    return this.http.snapshot();
  }

  async quote(symbol: string): Promise<StockQuote> {
    return normalizeQuote(
      await this.http.getJson<unknown>('/quote', { symbol }),
    );
  }

  async fetchCandles(
    symbol: string,
    timeframe: ChartTimeframe,
    from: Date,
    to: Date,
  ): Promise<CandleBar[]> {
    const body = await this.http.getJson<unknown>('/time_series', {
      symbol,
      interval: INTERVAL[timeframe],
      start_date: utcDateTime(from),
      end_date: utcDateTime(to),
      timezone: 'UTC',
      outputsize: '1000',
    });
    // "No data is available on the specified dates" is a 400-style error;
    // for a chart it simply means an empty range.
    const record = body as Record<string, unknown>;
    if (record['status'] === 'error' && Number(record['code']) === 400)
      return [];
    return normalizeTimeSeries(body);
  }
}
