# ADR 0007: Market-data providers, freshness and ingestion

**Status:** accepted (Milestones 5-6)

## Context
Prices must come from real, free, officially supported APIs, never be fabricated, and never be shown as live when they aren't. Free tiers have tight, different rate limits. GraphQL traffic must not translate into provider traffic.

## Providers (verified 2026-11-03)
| Provider | Used for | Auth | Our budget | Notes |
| --- | --- | --- | --- | --- |
| CoinGecko public API | Top-N crypto listings, market cap, global stats | none (optional demo key) | 8 req/min (25 with key) | Responses cached ~30-60s upstream; sends JSON numbers |
| Binance market data (`data-api.binance.vision`, `data-stream.binance.vision`) | Live prices (WebSocket miniTicker), candles | none | 300 req/min | Market-data-only endpoints. Prices are in **USDT** |
| Twelve Data | Stock/ETF quotes and candles | API key (free) | 8 req/min | Without a key, the public `demo` key covers AAPL only |

Not used: Yahoo Finance (no official API), CoinCap (API moved behind keys), Alpha Vantage (25 requests/day is too low for this design).

## Decision
- **Adapters + registry.** One adapter per provider with pure normalizers (tested against recorded real responses). `Binance` and `TwelveData` implement a shared `CandleProvider` interface. A registry picks the candle source per asset: Binance pair → Binance; stock → Twelve Data; otherwise **no charts** (e.g. USDT). Timeframes are never invented.
- **Every outbound call goes through `ProviderHttp`:**
  - a per-minute budget shared through Redis;
  - a shared cooldown honoring `Retry-After` after 429 (and Binance's 418);
  - a per-instance circuit breaker (5 consecutive failures → 60s open);
  - one retry for network/5xx only;
  - 5s timeouts;
  - health tracking exposed as `marketProviders`.
- **No uncontrolled fallback.** If a provider fails, we serve what's stored (flagged `isStale`), never silently try another provider.
- **Decimal safety.** Prices are strings end to end; Postgres `NUMERIC(38,12)` for candles. CoinGecko's JSON numbers are converted once to their shortest exact decimal string (`1.2e-7` → `"0.00000012"`); no arithmetic on floats. 24h change from Binance is computed with decimal.js.
- **Freshness computed at read time** from `sourceTimestamp`/`fetchedAt`:
  - `LIVE`: streamed by Binance, ≤30s old.
  - `CACHED`: polled snapshot, crypto ≤10 min.
  - `DELAYED`: all stocks; the free plan's latency can't be verified.
  - `STALE`: past the window.
  - A closed stock market's last price stays fresh as long as we keep refreshing it.
- **Storage.** Current quotes are Redis hashes (different sources update different fields: CoinGecko writes market cap and volume, the Binance stream writes price). Candles are persisted in Postgres with OHLC CHECK constraints and upserted (the forming candle converges to its final values).
- **Ingestion (in-process jobs, Redis lock per run):**
  - Crypto listings every 5 min.
  - Stock quotes every 30 min, which stays under 800 credits/day.
  - Hourly candles: crypto every hour, stocks every 3h.
  - A Binance combined WebSocket for all tracked pairs, with exponential backoff + jitter, a 60s watchdog, and resubscribe on symbol changes.
  - Price fan-out is capped at 1 message per asset per second.
- **Candles on demand.** Read from Postgres; fetch from the provider only when coverage is missing or the forming bar is old, with a per-asset+timeframe cooldown claimed in Redis. Many simultaneous chart opens = one upstream call. Requests are capped at 1000 bars.
- **USDT vs USD.** Binance prices are labelled `USDT` (not relabelled as USD). The simulated trading engine (Milestone 7) treats 1 USDT = 1 USD and says so.

## Alternatives considered
- **Query the provider on every GraphQL request.** Simple, but exhausts free tiers instantly and couples our latency to theirs.
- **Fallback chains across providers.** Can multiply traffic during outages (rate-limit cascades) and mixes data with different semantics.
- **BullMQ/separate worker process.** Better isolation and job state; unnecessary for four periodic jobs in a modular monolith. The lock-per-run design moves to a worker without changing the jobs.
- **Persist every tick.** Not needed: candles are the historical record; ticks are transient.

## Consequences
- Stock coverage depends on the user adding a free Twelve Data key.
- Gap detection only applies to 24/7 crypto markets; exchange sessions make stock gaps normal.
- Binance-only data reflects one exchange. Market cap and volume come from CoinGecko's cross-exchange aggregates.
