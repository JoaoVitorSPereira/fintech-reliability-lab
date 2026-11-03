# ADR 0012: Where the implementation differs from the brief, and why

**Status:** accepted (gap review after Milestone 12)

The brief is broad on purpose. These are the places where the code chooses differently, each with the reason, so a reviewer doesn't have to guess whether it was missed.

| Brief says | Implementation | Why |
| --- | --- | --- |
| Modules `users`, `assets`, `portfolios`, `watchlists`, `audit`, `notifications` | `users` is inside `identity`; `assets` inside `market-data`; `portfolios` and `watchlists` inside `trading`; audit = the append-only `transfers`/`trades`/ledger tables plus correlation ids; no notifications module | Split modules when a boundary earns it. These had no rules of their own yet, and an empty `notifications/` would be a promise, not a feature. |
| Domain entities, value objects, repository interfaces | Services use Prisma directly; invariants live in pure functions (`order-math`, `refresh-rotation`, `money`, `assertBalanced`) and in Postgres (constraints, triggers) | A repository interface with one Prisma implementation adds indirection without a second implementation to justify it. The critical rules are enforced by the database, where an interface can't bypass them. |
| `assetCandles: [Candle!]!` | `assetCandles: CandleSeries!` (`candles`, `isStale`, `isComplete`, `provider`, `note`) | A bare list can't say "these are stored candles because the provider is down" or "intervals are missing". The brief also requires never presenting stale data as live. |
| `portfolio: Portfolio!`, `watchlist: Watchlist!` | `portfolio: Portfolio` (null until `createPortfolio`), `watchlist: [WatchlistItem!]!` | The brief also says users *create* a portfolio; a non-null field would have to create one as a side effect of a read. |
| `transactionUpdated(accountId)` subscription | Folded into `accountUpdated` (new balance + the statement line) | One event (`AccountBalanceChanged`) carries both; two subscriptions would deliver the same event twice and could arrive out of order relative to each other. |
| Provider interface with `getAssets`, `getAssetPrice`, `getHistoricalPrices`, `getMarketOverview` on every adapter | A shared `CandleProvider` interface (Binance, Twelve Data) plus provider-specific methods | Providers don't offer the same things (the brief says so too). A uniform interface would force adapters to throw "not supported" at runtime; the registry picks a provider per capability instead. |
| Adapters for Alpha Vantage, Twelve Data, Yahoo, CoinCap, FMP | CoinGecko, Binance, Twelve Data | Checked 2026-11-03: CoinCap v3 needs a key and v2 is unreachable; Yahoo has no official API (scraping is ruled out by the brief); Alpha Vantage and FMP free tiers are too small for scheduled ingestion. |
| `PARTIALLY_FILLED` status | Not used | No order book is integrated, so partial fills would be invented liquidity. |
| TanStack Query, Axios in the app | Not used | The app talks only GraphQL. The brief allows them only for a justified non-GraphQL integration, and there isn't one. |
| Queues / workers infrastructure | In-process jobs with a Redis lock per run; outbox publisher polls with `SKIP LOCKED` | Four periodic jobs and one publisher don't justify a queue system yet. The jobs are written so they can move to a worker process unchanged. |
| Metrics | Prometheus metrics + structured logs; no tracing | Metrics cover everything section 15 lists. Distributed tracing is the next step if the monolith is ever split. |
| React Native profiling | Design-level measures (memoized rows, selectors, throttled subscriptions, downsampling); no device measurements | Needs a physical device and Hermes profiler session; listed as a known limit rather than claimed. |
