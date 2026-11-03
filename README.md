# Fintech Reliability Lab

A banking + paper-trading platform built to practise the parts of financial systems that are easy to get wrong: a double-entry ledger, idempotent transfers, row-level concurrency, real market data with honest freshness labels, a transactional outbox, GraphQL subscriptions, and session resilience on mobile.

**Stack:** React Native (Expo SDK 58) · Apollo Client 4 · NestJS 12 · Apollo Server 5 · PostgreSQL 17 · Prisma 7 · Redis 7. All TypeScript.

> **Trading is simulated.** No order ever reaches an exchange. Market data comes from public APIs (CoinGecko, Binance market-data endpoints, Twelve Data) and every price carries its source, timestamp and a freshness label (`LIVE`, `CACHED`, `DELAYED`, `STALE`).

| Sign in | Markets | Asset detail | Portfolio | Banking |
| --- | --- | --- | --- | --- |
| <img src="docs/screenshots/sign-in.png" width="160"> | <img src="docs/screenshots/markets.png" width="160"> | <img src="docs/screenshots/asset-detail.png" width="160"> | <img src="docs/screenshots/portfolio.png" width="160"> | <img src="docs/screenshots/banking.png" width="160"> |

*iOS simulator, Expo Go, live market data, demo user (the round button on two shots is the Expo Go developer menu).*

## Contents

1. [What it does](#what-it-does)
2. [System architecture](#system-architecture)
3. [Backend modules](#backend-modules)
4. [GraphQL API](#graphql-api)
5. [Ledger](#ledger)
6. [Transfers](#transfers)
7. [Market data](#market-data)
8. [Simulated trading](#simulated-trading)
9. [Events, outbox and subscriptions](#events-outbox-and-subscriptions)
10. [Authentication](#authentication)
11. [Mobile app](#mobile-app)
12. [Testing](#testing)
13. [Observability and security](#observability-and-security)
14. [Local development](#local-development)
15. [Decisions and known limits](#decisions-and-known-limits)

## What it does

| Banking | Investing (paper) |
| --- | --- |
| Sign up, sessions per device, revoke devices | Top 25 crypto assets + US stocks/ETFs with live or delayed prices |
| BRL checking account backed by a double-entry ledger | Line, candlestick and volume charts (5m to 1W), real provider candles only |
| Transfers between users, safe to retry (idempotency keys) | Watchlist, market overview, top gainers/losers, most traded |
| Simulated deposits (clearly labelled play money) | Market and limit orders filled against fresh market-data prices |
| Paginated statement with live updates | Positions, average cost, realized/unrealized P&L, allocation, performance history |

## System architecture

A modular monolith: one deployable API with strict module boundaries, plus background workers in the same process. Nothing here needs microservices yet.

```mermaid
flowchart LR
  subgraph App["React Native app (Expo)"]
    UI[Screens] --> AC[Apollo Client<br/>normalized cache]
    UI --> Z[Zustand<br/>UI state only]
    AC --> SS[SecureStore<br/>refresh token]
  end

  AC -- "HTTP: queries, mutations" --> GQL
  AC -- "WebSocket: graphql-ws" --> GQL

  subgraph API["NestJS modular monolith"]
    GQL[Apollo Server<br/>resolvers = adapters] --> MOD[Domain services<br/>identity · accounts · ledger · transfers<br/>market-data · trading · realtime]
    MOD --> OB[(outbox_events)]
    W1[Outbox publisher] --> OB
    W2[Ingestion jobs +<br/>Binance stream] --> MOD
    W3[Order matcher ·<br/>valuations · reconciliation] --> MOD
  end

  MOD <--> PG[(PostgreSQL<br/>source of truth)]
  MOD <--> RD[(Redis<br/>quotes · budgets · locks · pub/sub)]
  W1 -- publish --> RD
  RD -- fan-out --> GQL
  W2 <--> EXT[CoinGecko · Binance · Twelve Data]
```

**Rule of thumb:** Postgres holds everything that must be right (money, orders, events). Redis holds what can be rebuilt (quotes, rate budgets, job locks, fan-out). If Redis dies, prices and live updates degrade; balances don't.

## Backend modules

```text
apps/api/src
  modules/
    identity/      registration, login, sessions, refresh rotation, auth guard
    accounts/      accounts, statements (keyset pagination)
    ledger/        LedgerService.post (the only way money moves), reconciliation
    transfers/     transfers + simulated deposits, idempotency
    market-data/   provider adapters, quote store, candles, ingestion jobs, DataLoaders
    trading/       portfolios, orders, positions, P&L, watchlists, matcher
    events/        outbox, publisher worker, event bus
    realtime/      GraphQL subscriptions, missed-event recovery
  infrastructure/  database (Prisma, transaction retry), redis, logging, jobs
  graphql/         config, error whitelist, pagination, WebSocket auth
  shared/          errors, money, uuidv7
```

Resolvers translate GraphQL ↔ services and hold no business rules. Authorization lives in the services (`WHERE id = $1 AND user_id = $viewer`), so another user's resource is indistinguishable from a missing one.

## GraphQL API

Code-first schema; the generated SDL ([`apps/api/schema.graphql`](apps/api/schema.graphql)) is committed and CI fails on drift. The mobile app's types are generated from it, so CI also fails if a server change breaks the client.

```mermaid
sequenceDiagram
  participant App as Apollo Client
  participant L as Link chain (retry, auth, error)
  participant API as Apollo Server
  participant Guard as Auth guard
  participant R as Resolver
  participant S as Service
  participant DL as DataLoader
  App->>L: query
  L->>API: POST /graphql + Bearer token + x-request-id
  API->>API: parse, validate, depth limit
  API->>Guard: session still active?
  Guard->>R: viewer
  R->>S: use case (authorization in WHERE clauses)
  R->>DL: per-row fields (quote, sparkline)
  DL->>DL: batch: 1 Redis pipeline + 1 SQL
  API-->>App: data / whitelisted errors {extensions.code}
  Note over L: UNAUTHENTICATED → one shared refresh → replay once
```

- **Money is never a number on the wire:** `Money { amount: "1050.25", currency }`.
- **Errors:** expected failures carry stable codes (`INSUFFICIENT_FUNDS`, `IDEMPOTENCY_KEY_REUSED`, `NOT_FOUND`, …). Anything else becomes `INTERNAL_SERVER_ERROR`, on HTTP and WebSocket alike.
- **Limits:** query depth limit (fragments flattened), page sizes ≤ 100, ≤ 1000 candles per request, ≤ 50 assets per price subscription.

## Ledger

Every movement is a ledger transaction with ≥ 2 entries summing to zero per currency. Amounts are `BIGINT` minor units (centavos). Postgres enforces the rules itself, so an application bug fails loudly instead of corrupting money. [ADR 0005](docs/adr/0005-double-entry-ledger.md)

```mermaid
flowchart LR
  EF["external-funding:BRL<br/>(system, may go negative)"] -- "-R$1,000" --> T1(("deposit<br/>tx"))
  T1 -- "+R$1,000" --> A["Ana · checking"]
  A -- "-R$300" --> T2(("transfer<br/>tx"))
  T2 -- "+R$300" --> B["Bruno · checking"]
```

| Invariant | Enforced by |
| --- | --- |
| Customer balance never negative | `CHECK` on `accounts`; balance maintained by an insert trigger (`balance = balance + amount`) |
| Every transaction balances, ≥ 2 entries | Deferred constraint triggers, checked at `COMMIT` |
| Ledger is append-only | Triggers reject `UPDATE`/`DELETE`/`TRUNCATE`; fixes are reversal transactions |
| Entry currency = account currency | Composite FK `(account_id, currency)` |
| Cached balance = sum of entries; ledger sums to 0 | `verifyIntegrity()`: hourly job + `pnpm --filter api ledger:verify` |

## Transfers

```mermaid
sequenceDiagram
  participant App
  participant API
  participant DB as PostgreSQL
  App->>API: createTransfer(input + idempotencyKey)
  API->>DB: key already used? → return original (replayed: true)
  API->>DB: BEGIN (READ COMMITTED)
  API->>DB: SELECT … WHERE id IN (a, b) ORDER BY id FOR UPDATE
  API->>DB: check owner, recipient, currency, balance
  API->>DB: INSERT transfer (UNIQUE user_id + key)
  API->>DB: INSERT ledger tx + 2 entries (+ outbox events)
  API->>DB: COMMIT (deferred checks run)
  API-->>App: transfer
  Note over API,DB: 40P01/40001 → retry ≤3 with jitter (safe: idempotent)<br/>Duplicate in flight → P2002 or INSUFFICIENT_FUNDS → return the winner
```

- **Ordered locks** (sorted ids, one statement) make A→B / B→A deadlocks impossible. Removing the ordering in a mutation test produced 24 deadlock retries and a failing test.
- **Two R$800 withdrawals from R$1,000:** one succeeds, one gets `INSUFFICIENT_FUNDS`. An application-only balance check would let both read R$1,000 and pass.
- Same key + different request → `IDEMPOTENCY_KEY_REUSED`.

Details: [ADR 0006](docs/adr/0006-transfers-and-idempotency.md)

## Market data

| Provider | Used for | Key |
| --- | --- | --- |
| CoinGecko public API | Top-N listings, market cap, volume, global stats | none (optional demo key) |
| Binance market data (`data-api.binance.vision`, `data-stream.binance.vision`) | Live prices (WebSocket), candles; quotes in **USDT** | none |
| Twelve Data | Stocks/ETFs (SPY, QQQ as index stand-ins); quotes labelled `DELAYED` | free key; without it only AAPL |

```mermaid
flowchart LR
  CG[CoinGecko] -->|every 5 min| J1[listings job]
  TD[Twelve Data] -->|every 30 min| J2[stock quotes job]
  BN[Binance REST] -->|hourly + on demand| J3[candles]
  BWS[Binance WebSocket] -->|~1/s per symbol| ST[stream: backoff, watchdog]
  J1 & J2 & ST --> N[normalize to decimal strings]
  N --> Q[(Redis quote hashes)]
  J3 --> C[(Postgres candles)]
  ST -->|≤1 msg/asset/s| PS[(Redis md:prices)]
  subgraph guard["every outbound call: ProviderHttp"]
    B1[shared per-minute budget] --- B2[Retry-After cooldown] --- B3[circuit breaker] --- B4[1 retry for 5xx]
  end
```

Live price subscription lifecycle:

```mermaid
sequenceDiagram
  participant C as App (asset screen)
  participant API as API instance
  participant R as Redis md:prices
  participant BN as Binance stream
  C->>API: connection_init {authorization}
  API-->>C: connection_ack (or close 4403)
  C->>API: subscribe marketPriceUpdated([BTC], minIntervalMs: 1000)
  BN->>API: miniTicker → quote hash + PUBLISH (≤1/s/asset)
  R->>API: fan-out to every instance's event bus
  API->>API: filter to requested assets, throttle per subscription
  API-->>C: next {price, sourceTimestamp, dataQuality: LIVE}
  C->>C: cache.modify(MarketPrice:{BTC}) → only BTC views re-render
  Note over C,API: socket drops → graphql-ws reconnects with a fresh token<br/>→ refetch active queries (snapshot), then live again
  C->>API: complete (screen closed) → iterator returns, listener removed
```

- **No request ever proxies to a provider.** GraphQL reads Redis/Postgres. Charts refresh missing candles on demand with a cross-instance cooldown, so 10 users opening a chart = 1 upstream call.
- **Freshness is computed when read**, from timestamps: `LIVE` (streamed, ≤ 30s), `CACHED` (polled), `DELAYED` (stocks), `STALE` (past its window). A dead job can't leave "fresh" labels behind.
- **Nothing is invented.** Assets without a candle provider show no chart; gaps are reported (`isComplete: false`), never filled. Provider down → stored candles with `isStale: true` and a note.

Details and provider limits: [ADR 0007](docs/adr/0007-market-data-providers-and-ingestion.md)

## Simulated trading

Each portfolio owns two USD ledger accounts (available cash, reserved for limit buys) whose counterparty is `simulated-market:USD`. Positions store quantity (18 decimals), reserved quantity, cost basis and realized P&L.

```mermaid
flowchart TD
  O[createSimulatedOrder] --> L[lock portfolio row]
  L --> K[claim idempotency key]
  K --> T{type}
  T -->|MARKET| P{fresh price?<br/>crypto ≤60s · stock market open}
  P -->|no| RJ[REJECTED + reason]
  P -->|yes| X[execute]
  T -->|LIMIT| H[hold cash / reserve units]
  H --> M{marketable now?}
  M -->|yes| X
  M -->|no| PD[PENDING]
  PD -->|matcher every 2s| X
  X --> LG[ledger TRADE posting<br/>buy rounds up · sell rounds down]
  LG --> POS[update position<br/>average cost · realized P&L]
  POS --> TR[trade row + order FILLED]
  TR --> EV[outbox: SimulatedOrderUpdated]
```

Every order carries `isSimulated: true` and a disclaimer: fills in full at the latest market-data price, with no spread, slippage, fees, partial fills or order book, and USDT counted as USD.

```mermaid
sequenceDiagram
  participant Price as Binance stream
  participant Cache as Apollo cache
  participant API
  participant DB as PostgreSQL
  Price->>API: tick (≤1/s/asset)
  API-->>Cache: marketPriceUpdated → MarketPrice:{assetId}
  Note over Cache: every screen showing the asset re-renders<br/>positions re-value on the client
  API->>DB: order filled (same tx: outbox event)
  API-->>Cache: simulatedOrderUpdated
  Cache->>API: refetch portfolio (authoritative cash + positions)
  API->>DB: every 15 min: portfolio valuation snapshot (performance chart)
```

Details: [ADR 0008](docs/adr/0008-simulated-trading.md)

## Events, outbox and subscriptions

```mermaid
sequenceDiagram
  participant S as Service
  participant DB as PostgreSQL
  participant W as Publisher worker
  participant R as Redis pub/sub
  participant B as Event bus (per instance)
  participant C as Client
  S->>DB: BEGIN, change state, INSERT outbox_events, COMMIT
  loop every 250 ms
    W->>DB: SELECT … FOR UPDATE SKIP LOCKED (earlier events of the aggregate first)
    W->>R: PUBLISH events:account
    W->>DB: mark published (crash before this = republish)
  end
  R->>B: message
  B->>B: dedupe by event id
  B-->>C: accountUpdated (balance re-read from DB, sequence n)
  Note over C: gap in sequence or reconnect → missedEvents(afterSequence) / refetch
```

- **Delivery is at-least-once** from the outbox (consumers dedupe on `id`) and **at-most-once** over Redis pub/sub (hence `missedEvents` from the durable table). There is no exactly-once claim.
- Failed publishes back off exponentially and are dead-lettered after 12 attempts. One stuck event blocks only its own aggregate.
- **WebSocket auth:** the token goes in `connectionParams`, never the URL. The session is re-checked every 60s; a revoked session is closed with `4401` and the app refreshes and reconnects.
- `marketPriceUpdated` streams only requested assets, throttled per subscription (≈1s detail screen, 3–5s lists).

Details: [ADR 0009](docs/adr/0009-transactional-outbox.md), [ADR 0010](docs/adr/0010-graphql-subscriptions.md)

## Authentication

Server-side sessions with short-lived JWT access tokens and single-use, rotating refresh tokens. Details and trade-offs: [ADR 0004](docs/adr/0004-sessions-and-refresh-token-rotation.md).

```mermaid
sequenceDiagram
  participant App
  participant API
  participant DB as PostgreSQL

  App->>API: login(email, password)
  API->>DB: verify argon2id hash, create session + refresh token R1
  API-->>App: access JWT (15 min) + R1

  App->>API: me (Authorization: Bearer JWT)
  API->>DB: session active? (checked on every request)
  API-->>App: user

  App->>API: refreshSession(R1)
  API->>DB: lock session row, mark R1 rotated, insert R2
  API-->>App: new JWT + R2

  Note over App,API: Response lost? Retrying R1 within 30s while R2 is unused<br/>revokes R2 and issues R3.

  App->>API: refreshSession(R1) after R2 was used
  API->>DB: reuse detected: revoke session and all its tokens
  API-->>App: UNAUTHENTICATED
```

| Guarantee | Enforced by |
|---|---|
| Logout/revoke takes effect immediately | Session check on every request |
| One live refresh token per session | Row lock **and** a partial unique index |
| Replayed refresh token kills the session | Rotation history + reuse detection |
| No duplicate accounts (`A@x.com` vs `a@x.com`) | Normalization **and** a `CHECK (email = lower(email))` constraint |
| Unknown email and wrong password look identical | Same error, dummy argon2 verify for unknown emails |
| Online password guessing is slowed | 5 failures / 15 min per account (Redis, fails open) |
| New resolvers are protected by default | Global guard, opt out with `@Public()` |

Expected failures are `AppError`s with a stable `extensions.code` (`INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `UNAUTHENTICATED`, …), which the app switches on. Anything else reaches the client as `INTERNAL_SERVER_ERROR`.

On the client, a `SessionManager` keeps the access token in memory and the refresh token in SecureStore (Keychain, this device only). Concurrent `UNAUTHENTICATED` responses share **one** refresh, then each operation is replayed once. Network errors during a refresh keep the token, because the server's 30s grace window makes retrying safe.

## Mobile app

`apps/mobile`, Expo Router with native tabs. Runs in Expo Go. [ADR 0011](docs/adr/0011-mobile-app-architecture.md)

| Concern | Choice |
| --- | --- |
| Server state | Apollo Client 4: normalized cache, `cache-and-network` by default, cursor pagination merges, subscriptions written into `MarketPrice:{assetId}` |
| Types | GraphQL Code Generator (client preset) from the API's committed SDL |
| UI state | Zustand (timeframe, chart mode, market tab and sort), read with selectors; server data is never copied into it |
| Forms | React Hook Form + Zod, mirroring server rules |
| Charts | Victory Native 42 on Skia: line, area, candlestick, volume bars; data downsampled for display |
| Styling | styled-components with light/dark theme tokens |
| Retries | Queries on network errors; mutations only if they carry an idempotency key; one key per user intent, rotated after success |
| Money in the UI | Formatted from strings; never parsed into floats (only chart pixels use numbers) |
| Not used | TanStack Query and Axios: there is no REST integration that would justify them |

Financial results are never optimistic: a transfer or order shows as done only after the server commits. The watchlist uses an optimistic response because it isn't money.

## Testing

| Layer | What | Where |
| --- | --- | --- |
| API unit | money parsing, ledger balancing, order math, provider normalizers (recorded real responses), refresh decisions, retry policy | `apps/api/src/**/*.spec.ts` |
| API integration | real Postgres + Redis: concurrency (withdrawals, opposing transfers, duplicate keys, concurrent orders, concurrent refresh), DB invariants via raw SQL, provider failures against a fake HTTP server, outbox retry/ordering/dead letters, WebSocket subscriptions and authorization | `apps/api/test/*.e2e.spec.ts` |
| Journey | the spec's 18-step end-to-end scenario against a running server | `apps/api/test/full-flow.e2e.spec.ts` |
| Mobile | single-flight refresh, exact money formatting, pagination merge, freshness badge rendering | `apps/mobile/src/**/__tests__` |
| Performance | N+1 vs DataLoader, index vs none, hot-account contention | `pnpm --filter api bench`, [docs/performance.md](docs/performance.md) |

Several tests were **mutation-tested**: the guard was removed to prove the test fails (the refresh-session lock, the overdraft `CHECK`, ordered locking), then restored.

CI (GitHub Actions) runs typecheck, lint, all API and mobile tests against Postgres and Redis service containers, and both schema drift checks.

## Observability and security

- **Structured logs (pino)** with a request id on every line, echoed as `x-request-id` and stored as `correlation_id` on transfers, orders and outbox events.
- **Logged:** GraphQL operation name, type, duration and error codes; provider latency, 429s, circuit state; outbox backlog; job durations; WebSocket connection counts.
- **Never logged:** variables, tokens, passwords, balances. Redaction is a second layer of protection.
- **Health:** `/health/live` (process only) vs `/health/ready` (Postgres + Redis with timeouts).
- **Production hardening:** introspection and GraphiQL off, CSRF prevention, depth limit, internal errors masked.
- **Configuration:** env validated with Zod at boot (fails without echoing values). The dev JWT secret is refused in production. Provider keys are optional and never committed.

## Local development

Requirements: Node 24 (`nvm use`), pnpm 12, Docker; Xcode or Android Studio for the app (or Expo Go on a device).

```bash
docker compose up -d                      # Postgres :5433, Redis :6379
cp apps/api/.env.example apps/api/.env    # optional: add TWELVE_DATA_API_KEY for more stocks
pnpm install
pnpm --filter api prisma:migrate          # apply migrations to the dev database
pnpm dev                                  # API on http://localhost:4000/graphql

cd apps/mobile
EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start   # press i for iOS simulator
```

On a physical device, use your computer's LAN IP in `EXPO_PUBLIC_API_URL`.

| Command | What it does |
| --- | --- |
| `pnpm test` | API + mobile tests (needs `docker compose up`) |
| `pnpm typecheck` / `pnpm lint` | `tsc` everywhere / `oxlint --type-aware` on the API |
| `pnpm --filter api bench` | Performance experiments (prints a markdown table) |
| `pnpm --filter api ledger:verify` | Reconcile the ledger; exit 1 on drift (run after `pnpm --filter api build`) |
| `pnpm --filter mobile codegen` | Regenerate app types from `apps/api/schema.graphql` |

Tests use the `fintech_test` database and Redis DB 1, never your dev data, and never call real market-data providers.

## Decisions and known limits

Architecture Decision Records live in [`docs/adr`](docs/adr):

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-code-first-graphql.md) | Code-first GraphQL, committed SDL |
| [0002](docs/adr/0002-prisma-with-raw-sql-for-locking.md) | Prisma, raw SQL where locking matters |
| [0003](docs/adr/0003-node-24-and-module-format.md) | Node 24, CommonJS app on ESM-only Nest 12 |
| [0004](docs/adr/0004-sessions-and-refresh-token-rotation.md) | Server-side sessions, rotating refresh tokens |
| [0005](docs/adr/0005-double-entry-ledger.md) | Double-entry ledger with DB-enforced invariants |
| [0006](docs/adr/0006-transfers-and-idempotency.md) | Idempotency keys and ordered row locks |
| [0007](docs/adr/0007-market-data-providers-and-ingestion.md) | Providers, freshness, ingestion |
| [0008](docs/adr/0008-simulated-trading.md) | Paper-trading engine |
| [0009](docs/adr/0009-transactional-outbox.md) | Transactional outbox, at-least-once |
| [0010](docs/adr/0010-graphql-subscriptions.md) | graphql-ws subscriptions |
| [0011](docs/adr/0011-mobile-app-architecture.md) | Mobile app architecture |

**Known limits (deliberate, documented):**
- No per-IP rate limits, JWT key rotation, email verification, or "password change revokes other sessions" yet.
- Recipients are addressed by account id (a real bank uses an account number or key plus a name-confirmation step).
- `simulated-market:USD` is a hot row: trades across all users serialize on it.
- In-process workers; move them to a separate process or queue when isolation matters. Scheduled jobs take a Redis lock per run, but each instance with `MARKET_INGESTION_ENABLED=true` opens its own Binance stream: enable ingestion on one instance.
- No metrics export (Prometheus/OpenTelemetry), no network load test (k6), no on-device React Native profiling yet.
- Stock coverage depends on a free Twelve Data key; Binance prices are USDT, treated as USD for paper trading.
