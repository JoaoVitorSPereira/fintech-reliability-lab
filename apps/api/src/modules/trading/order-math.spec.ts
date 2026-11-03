import { Prisma } from '../../generated/prisma/client';
import type { StoredQuote } from '../market-data/market-data.types';
import {
  applyBuy,
  applySell,
  buyCostMinor,
  executablePrice,
  limitIsMarketable,
  parsePrice,
  parseQuantity,
  sellProceedsMinor,
} from './order-math';

const d = (value: string) => new Prisma.Decimal(value);

describe('order math', () => {
  it('rounds buy cost up and sell proceeds down to the cent', () => {
    // 0.333 * 10.01 = 3.33333 dollars
    expect(buyCostMinor(d('0.333'), d('10.01'))).toBe(334n);
    expect(sellProceedsMinor(d('0.333'), d('10.01'))).toBe(333n);
    expect(buyCostMinor(d('2'), d('50'))).toBe(10_000n); // exact: no rounding
  });

  it('never uses floating point: 0.1 + 0.2 style values stay exact', () => {
    expect(buyCostMinor(d('0.1'), d('0.2'))).toBe(2n); // 0.02 dollars
    expect(buyCostMinor(d('3'), d('0.1'))).toBe(30n);
  });

  it('tracks average cost and realized P&L across buys and sells', () => {
    let position = { quantity: d('0'), costBasis: d('0'), realizedPnl: d('0') };
    position = applyBuy(position, d('1'), 10_000n); // 1 @ $100
    position = applyBuy(position, d('1'), 20_000n); // 1 @ $200, avg $150
    const afterSell = applySell(position, d('1'), 25_000n); // sell 1 @ $250
    expect(afterSell.realizedOnTrade.toFixed()).toBe('100'); // 250 - 150
    expect(afterSell.costBasis.toFixed()).toBe('150');
    expect(afterSell.quantity.toFixed()).toBe('1');

    const flat = applySell(afterSell, d('1'), 10_000n); // sell last @ $100
    expect(flat.realizedOnTrade.toFixed()).toBe('-50');
    expect(flat.costBasis.toFixed()).toBe('0'); // no dust left behind
    expect(flat.realizedPnl.toFixed()).toBe('50');
  });

  it('validates quantity and price inputs strictly', () => {
    expect(parseQuantity('0.00000001')?.toFixed()).toBe('0.00000001');
    for (const bad of ['0', '-1', '1e3', '0.000000001', 'abc', '', '01'])
      expect(parseQuantity(bad)).toBeNull();
    expect(parsePrice('76950.5')?.toFixed()).toBe('76950.5');
    expect(parsePrice('0')).toBeNull();
  });

  it('decides limit marketability by side', () => {
    expect(limitIsMarketable('BUY', d('100'), d('99.99'))).toBe(true);
    expect(limitIsMarketable('BUY', d('100'), d('100.01'))).toBe(false);
    expect(limitIsMarketable('SELL', d('100'), d('100'))).toBe(true);
    expect(limitIsMarketable('SELL', d('100'), d('99'))).toBe(false);
  });

  describe('executable price', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const quote = (o: Partial<StoredQuote>): StoredQuote => ({
      assetId: 'a',
      price: '100',
      currency: 'USDT',
      change24hPct: null,
      volume24h: null,
      marketCap: null,
      provider: 'binance-stream',
      sourceTimestamp: '2026-11-03T11:59:59Z',
      fetchedAt: '2026-11-03T11:59:59Z',
      marketOpen: null,
      ...o,
    });

    it('fills crypto on a fresh price', () => {
      expect(executablePrice('CRYPTO', quote({}), now)).toMatchObject({
        ok: true,
        provider: 'binance-stream',
      });
    });

    it('refuses crypto prices older than 60s', () => {
      expect(
        executablePrice(
          'CRYPTO',
          quote({ sourceTimestamp: '2026-11-03T11:58:00Z' }),
          now,
        ),
      ).toEqual({
        ok: false,
        reason: 'Price is stale (last update 120s ago).',
      });
    });

    it('refuses stocks while the market is closed', () => {
      expect(
        executablePrice(
          'STOCK',
          quote({ provider: 'twelve-data', marketOpen: false }),
          now,
        ),
      ).toEqual({ ok: false, reason: 'Market is closed.' });
    });

    it('refuses when there is no price at all', () => {
      expect(executablePrice('CRYPTO', null, now).ok).toBe(false);
    });
  });
});
