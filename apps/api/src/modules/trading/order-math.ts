import { Prisma } from '../../generated/prisma/client';
import type { AssetCategory } from '../../generated/prisma/enums';
import type { StoredQuote } from '../market-data/market-data.types';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export const MIN_NOTIONAL_MINOR = 100n; // $1.00
export const MAX_NOTIONAL_MINOR = 100_000_000n; // $1,000,000.00
/** A crypto fill needs a price no older than this. */
export const MAX_CRYPTO_PRICE_AGE_MS = 60_000;
const STOCK_MAX_FETCH_AGE_MS = 2 * 60 * 60_000;

const QUANTITY = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
const PRICE = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;

export function parseQuantity(text: string): Decimal | null {
  if (!QUANTITY.test(text)) return null;
  const value = new Decimal(text);
  return value.gt(0) ? value : null;
}

export function parsePrice(text: string): Decimal | null {
  if (!PRICE.test(text)) return null;
  const value = new Decimal(text);
  return value.gt(0) ? value : null;
}

// Rounding always favours the platform, never the user's balance sheet
// accidentally: a buy debits cash rounded UP to the cent, a sell credits
// cash rounded DOWN. The difference is at most one cent per trade.
export function buyCostMinor(quantity: Decimal, price: Decimal): bigint {
  return BigInt(
    quantity
      .times(price)
      .times(100)
      .toDecimalPlaces(0, Decimal.ROUND_CEIL)
      .toFixed(0),
  );
}

export function sellProceedsMinor(quantity: Decimal, price: Decimal): bigint {
  return BigInt(
    quantity
      .times(price)
      .times(100)
      .toDecimalPlaces(0, Decimal.ROUND_FLOOR)
      .toFixed(0),
  );
}

export function minorToDollars(minor: bigint): Decimal {
  return new Decimal(minor.toString()).div(100);
}

export type PositionState = {
  quantity: Decimal;
  costBasis: Decimal;
  realizedPnl: Decimal;
};

// Average-cost method: a buy adds its cost; a sell removes the average cost
// of the units sold, and the difference to the proceeds is realized P&L.
export function applyBuy(
  position: PositionState,
  quantity: Decimal,
  costMinor: bigint,
): PositionState {
  return {
    quantity: position.quantity.plus(quantity),
    costBasis: position.costBasis.plus(minorToDollars(costMinor)),
    realizedPnl: position.realizedPnl,
  };
}

export function applySell(
  position: PositionState,
  quantity: Decimal,
  proceedsMinor: bigint,
): PositionState & { realizedOnTrade: Decimal } {
  const remaining = position.quantity.minus(quantity);
  // Selling everything removes the whole basis, so no rounding dust remains.
  const costOfSold = remaining.isZero()
    ? position.costBasis
    : position.costBasis
        .times(quantity)
        .div(position.quantity)
        .toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN);
  const realizedOnTrade = minorToDollars(proceedsMinor).minus(costOfSold);
  return {
    quantity: remaining,
    costBasis: position.costBasis.minus(costOfSold),
    realizedPnl: position.realizedPnl.plus(realizedOnTrade),
    realizedOnTrade,
  };
}

export type ExecutablePrice =
  | { ok: true; price: Decimal; provider: string; timestamp: Date }
  | { ok: false; reason: string };

// The simulated engine only fills against a price that is fresh enough to
// pretend it was executable. Everything else is rejected (market orders) or
// left pending (limit orders).
export function executablePrice(
  category: AssetCategory,
  quote: StoredQuote | null,
  now: number = Date.now(),
): ExecutablePrice {
  if (!quote)
    return {
      ok: false,
      reason: 'No market price is available for this asset yet.',
    };
  const timestamp = new Date(quote.sourceTimestamp);
  if (category === 'CRYPTO') {
    const age = now - timestamp.getTime();
    if (age > MAX_CRYPTO_PRICE_AGE_MS) {
      return {
        ok: false,
        reason: `Price is stale (last update ${Math.round(age / 1000)}s ago).`,
      };
    }
  } else {
    if (now - Date.parse(quote.fetchedAt) > STOCK_MAX_FETCH_AGE_MS) {
      return { ok: false, reason: 'Price is stale.' };
    }
    if (!quote.marketOpen) return { ok: false, reason: 'Market is closed.' };
  }
  return {
    ok: true,
    price: new Decimal(quote.price),
    provider: quote.provider,
    timestamp,
  };
}

/** Limit orders fill when the reference price is at or better than the limit. */
export function limitIsMarketable(
  side: 'BUY' | 'SELL',
  limit: Decimal,
  price: Decimal,
): boolean {
  return side === 'BUY' ? price.lte(limit) : price.gte(limit);
}
