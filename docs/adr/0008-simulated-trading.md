# ADR 0008: Simulated (paper) trading engine

**Status:** accepted (Milestone 7)

## Context
Users trade against real market data, but nothing is sent to an exchange. The engine must be clearly labelled as simulated, and keep cash, positions, orders and trades consistent under concurrency and retries.

## Decision
- **Portfolio = two ledger accounts + positions.** A USD `PORTFOLIO_CASH` account (available) and a USD `PORTFOLIO_RESERVED` account (held for limit buys). Available and reserved cash are ledger balances, so all cash movement is double-entry and reconciled with the rest of the ledger. The counterparty of every trade is the system account `simulated-market:USD`.
- **Funding** only through `simulateDeposit` (USD). Banking transfers move `CHECKING` money only, so paper cash can't leave or be raced from outside the order engine.
- **Positions** are `NUMERIC(38,18)` quantities with `reserved_quantity` (held for limit sells), a USD cost basis (average-cost method) and cumulative realized P&L. CHECK constraints keep `0 ≤ reserved ≤ quantity` and "flat position has zero cost".
- **Execution assumptions (shown on every order as `disclaimer`, with `isSimulated: true`):**
  - fills in full at the latest market-data price;
  - no spread, slippage, fees, partial fills, order book or liquidity limits;
  - Binance USDT prices are treated as USD.
- **Price must be executable:**
  - Crypto: quote no older than 60s.
  - Stocks: market open and quote refreshed within 2h.
  - Otherwise a market order is **REJECTED** with a reason, and a limit order stays **PENDING**.
- **Rounding:** buys debit cash rounded up to the cent, sells credit rounded down. Bounded to 1 cent per trade.
- **Order lifecycle:** `PENDING → FILLED | CANCELLED`, or `REJECTED` at placement. A trigger forbids leaving a final state and changing order terms.
  - Business rejections (stale price, closed market, insufficient cash or units, below the $1 minimum) are **persisted orders**, not errors. Input errors are errors.
- **Limit orders:** a buy holds `ceil(qty × limit)` (cash → reserved). On fill, the hold pays the market and the difference is refunded. A sell reserves units. Marketable limits fill immediately. Otherwise a matcher job (every 2s, Redis-locked) fills them when the reference price reaches the limit.
- **Concurrency:**
  - Every order operation locks the portfolio row (`FOR UPDATE`) and re-reads state under the lock. The matcher re-checks `status = PENDING` under the lock (idempotent execution); `trades.order_id` is unique as a backstop.
  - Ledger CHECK constraints still refuse any overdraft.
- **Idempotency:** `UNIQUE (user_id, idempotency_key)` on orders plus request hash, same pattern as transfers (ADR 0006). A rejected order replays as rejected.
- **Valuation** at read time from the latest quotes. Stale or missing prices are still shown, but flagged (`valuationIsStale`, `priceIsStale`). Day change is derived from each quote's 24h change and is null if any is unknown. A job snapshots portfolio values every 15 min for the performance chart.

## Alternatives considered
- **Positions as ledger accounts per asset.** Fully double-entry for units too, but needs a `NUMERIC` ledger or per-asset scaling. The trade table plus position CHECKs gives the audit trail without that.
- **Partial fills / simulated order book.** More realistic, but invents liquidity data we don't have. Explicitly out of scope.
- **FIFO cost basis.** Needs lot tracking; average cost is standard for retail summaries and simpler to explain.

## Consequences
- `simulated-market:USD` is a hot row: every trade updates it, so trades across all users serialize on it. Fine for a demo. Shard it per asset or skip its cached balance if throughput ever matters.
- A user's order throughput is bounded by the portfolio lock.
- P&L is in USD paper money and never converted to BRL.
