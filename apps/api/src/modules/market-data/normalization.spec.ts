import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderError, toDecimalString } from './market-data.types';
import { normalizeKlines, normalizeMiniTicker } from './providers/binance';
import { normalizeGlobal, normalizeMarkets } from './providers/coingecko';
import { normalizeQuote, normalizeTimeSeries } from './providers/twelve-data';
import { assessQuote } from './quote-store';
import type { StoredQuote } from './market-data.types';

// Fixtures are real responses recorded from the providers (test/fixtures).
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '../../../test/fixtures', name), 'utf8'),
  );
}

describe('decimal conversion', () => {
  it.each([
    [76795, '76795'],
    [2252.68, '2252.68'],
    [1.2e-7, '0.00000012'],
    ['0.00001234', '0.00001234'],
    [1543999804108, '1543999804108'],
  ])('converts %p to %p without exponent notation', (input, expected) => {
    expect(toDecimalString(input)).toBe(expected);
  });

  it.each([null, undefined, '', NaN, Infinity, 'abc', {}])(
    'treats %p as missing',
    (input) => {
      expect(toDecimalString(input)).toBeNull();
    },
  );
});

describe('CoinGecko normalization', () => {
  it('normalizes /coins/markets into listing rows', () => {
    const rows = normalizeMarkets(fixture('coingecko-markets.json'));
    expect(rows.length).toBe(5);
    expect(rows[0]).toMatchObject({
      coingeckoId: 'bitcoin',
      symbol: 'BTC',
      marketCapRank: 1,
    });
    expect(typeof rows[0]!.price).toBe('string');
    expect(rows[0]!.sourceTimestamp).toBeInstanceOf(Date);
  });

  it('skips malformed rows instead of failing the batch', () => {
    const rows = normalizeMarkets([
      { id: 1 },
      {
        id: 'x',
        symbol: 'x',
        name: 'X',
        current_price: 1,
        last_updated: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(rows.map((row) => row.coingeckoId)).toEqual(['x']);
  });

  it('rejects a non-array body', () => {
    expect(() => normalizeMarkets({ status: { error_code: 429 } })).toThrow(
      ProviderError,
    );
  });

  it('normalizes /global', () => {
    const global = normalizeGlobal(fixture('coingecko-global.json'));
    expect(global.totalMarketCapUsd).toMatch(/^\d+(\.\d+)?$/);
    expect(global.btcDominancePct).toMatch(/^\d+(\.\d+)?$/);
  });
});

describe('Binance normalization', () => {
  it('normalizes klines, keeping provider strings exact', () => {
    const bars = normalizeKlines(fixture('binance-klines.json'));
    expect(bars).toHaveLength(3);
    expect(bars[0]!.open).toMatch(/^\d+(\.\d+)?$/);
    expect(bars[0]!.openTime.getUTCMinutes()).toBe(0);
  });

  it('computes 24h change from the miniTicker in decimal arithmetic', () => {
    const ticker = normalizeMiniTicker(fixture('binance-miniticker.json'))!;
    expect(ticker.symbol).toBe('BTCUSDT');
    // (77034.01 - 78068) / 78068 * 100 = -1.3245...
    expect(ticker.change24hPct).toBe('-1.3245');
    expect(ticker.price).toBe('77034.01');
  });

  it('ignores other event types', () => {
    expect(normalizeMiniTicker({ e: 'trade', s: 'BTCUSDT' })).toBeNull();
  });
});

describe('Twelve Data normalization', () => {
  it('normalizes a quote', () => {
    const quote = normalizeQuote(fixture('twelvedata-quote.json'));
    expect(quote).toMatchObject({ symbol: 'AAPL', marketOpen: false });
    expect(quote.price).toMatch(/^\d+\.\d+$/);
  });

  it('maps HTTP-200 error payloads to typed provider errors', () => {
    expect(() => normalizeQuote(fixture('twelvedata-error-401.json'))).toThrow(
      expect.objectContaining({ kind: 'NOT_CONFIGURED' }),
    );
  });

  it('parses UTC intraday datetimes and returns oldest first', () => {
    const bars = normalizeTimeSeries(fixture('twelvedata-time-series.json'));
    expect(bars.length).toBe(3);
    expect(bars[0]!.openTime.getTime()).toBeLessThan(
      bars[2]!.openTime.getTime(),
    );
    expect(bars[2]!.openTime.toISOString()).toBe('2026-11-02T20:30:00.000Z');
  });
});

describe('quote freshness (computed at read time)', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const quote = (overrides: Partial<StoredQuote>): StoredQuote => ({
    assetId: 'a',
    price: '1',
    currency: 'USD',
    change24hPct: null,
    volume24h: null,
    marketCap: null,
    provider: 'coingecko',
    sourceTimestamp: '2026-11-03T11:59:00Z',
    fetchedAt: '2026-11-03T11:59:30Z',
    marketOpen: null,
    ...overrides,
  });

  it('labels a fresh streamed price LIVE', () => {
    expect(
      assessQuote(
        quote({
          provider: 'binance-stream',
          sourceTimestamp: '2026-11-03T11:59:50Z',
        }),
        'CRYPTO',
        now,
      ),
    ).toEqual({
      isStale: false,
      dataQuality: 'LIVE',
      marketStatus: 'ALWAYS_OPEN',
    });
  });

  it('downgrades a streamed price to CACHED once it is older than 30s', () => {
    expect(
      assessQuote(quote({ provider: 'binance-stream' }), 'CRYPTO', now)
        .dataQuality,
    ).toBe('CACHED');
  });

  it('marks crypto STALE after 10 minutes, whatever the provider', () => {
    expect(
      assessQuote(
        quote({ sourceTimestamp: '2026-11-03T11:45:00Z' }),
        'CRYPTO',
        now,
      ),
    ).toMatchObject({ isStale: true, dataQuality: 'STALE' });
  });

  it('keeps a closed market fresh while we keep refreshing it', () => {
    const friday = quote({
      provider: 'twelve-data',
      sourceTimestamp: '2026-10-30T20:00:00Z',
      marketOpen: false,
    });
    expect(assessQuote(friday, 'STOCK', now)).toEqual({
      isStale: false,
      dataQuality: 'DELAYED',
      marketStatus: 'CLOSED',
    });
  });

  it('marks stocks STALE when we stop refreshing them', () => {
    expect(
      assessQuote(
        quote({ provider: 'twelve-data', fetchedAt: '2026-11-03T09:00:00Z' }),
        'STOCK',
        now,
      ).isStale,
    ).toBe(true);
  });
});
