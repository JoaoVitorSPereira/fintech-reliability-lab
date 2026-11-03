# Performance and reliability notes (Milestone 11)

Measured 2026-11-03 on a Mac mini (Apple silicon), Postgres 17 and Redis 7 in Docker, test database with ~18k ledger entries. Re-run with `pnpm --filter api bench`. Numbers vary by machine; the ratios are the point.

## Results

| Experiment | Variant | p50 | p95 | Notes |
| --- | --- | --- | --- | --- |
| Asset list (25 rows) | naive: 2 round trips per row (50) | 8.94 ms | 11.11 ms | what field resolvers do without batching |
| Asset list (25 rows) | DataLoader: 1 Redis pipeline + 1 SQL | 1.07 ms | 1.53 ms | shipped |
| Statement first page (10k entries) | with `(account_id, id)` index | 0.02 ms | 0.04 ms | Postgres execution time |
| Statement first page (10k entries) | without index (dropped inside a rolled-back transaction) | 0.62 ms | 1.26 ms | Postgres execution time |
| 200 transfers, 10 concurrent | spread over 20 senders | 23.95 ms | 30.33 ms | full GraphQL request |
| 200 transfers, 10 concurrent | all from one hot account | 29.41 ms | 33.39 ms | serialized by the account row lock |

## What they show

- **N+1 is the biggest win.** Batching quotes and sparklines took the asset list from 50 round trips to 2, about 8× faster at p50. The gap grows linearly with rows and with network latency to Redis/Postgres, which is near zero here and is not in production.
- **The statement index is ~30× faster** even on a small table. Without it, Postgres walks the primary key backwards and filters by account; that cost grows with the whole table, not with the account's history. With it, the first page reads 26 index entries no matter how big the ledger gets.
- **Hot accounts serialize, by design.** Transfers from one account wait for its row lock, so p50 rose ~23% at 10-way concurrency. That's the price of a correct balance check. Mitigations if it ever matters: shorter transactions, fewer round trips inside the lock, or splitting a hot system account (see ADR 0005/0008).

## Reliability work in this milestone

- **18-step journey test** (`test/full-flow.e2e.spec.ts`), the spec's end-to-end list in order:
  - authenticate, dashboard, listings, candles, live subscription, watchlist;
  - buy, position, sell, realized P&L;
  - disconnect and recover missed events;
  - expired token, concurrent refresh, duplicate transfers, concurrent withdrawals;
  - worker restart, ledger integrity.
- **Hourly ledger reconciliation job.** It logs at error level with account ids only (no balances) if cached balances drift from the entries or the ledger doesn't sum to zero.
- **`pnpm --filter api ledger:verify`.** An ops command that exits 1 on drift.
- **CI now also typechecks and tests the mobile app,** and fails if its generated GraphQL types don't match the API schema.

## Flaky tests found and fixed

The full suite was run repeatedly. Two intermittent failures were test-isolation bugs, not product bugs:
1. The journey test transferred money to "the newest checking account", which could belong to the parallel transfers suite. It broke that suite's balance-sum assertion. Now it only uses its own accounts.
2. The events suite marked *every* pending outbox event as published before each test, including the journey test's fresh events. Now it only clears backlog older than two minutes.

The fake market-data server used one fixed port for all suites, so two suites raced for it. It now uses a port per Jest worker. After the fixes: 193/193 passed on 5 consecutive runs.

## Not done (would be next)

- Load testing over the network with a real tool (k6) against a production build, including WebSocket fan-out with thousands of subscribers.
- Metrics export (Prometheus/OpenTelemetry). Today, structured logs carry durations, error codes, outbox backlog and provider health.
- React Native profiling on a physical device (Hermes profiler, React DevTools). The code uses memoized rows, Zustand selectors and per-screen subscription throttling, but no device measurements were taken.
