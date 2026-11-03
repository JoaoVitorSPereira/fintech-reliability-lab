# ADR 0010: GraphQL subscriptions over graphql-ws

**Status:** accepted (Milestone 9)

## Decision
- **Transport:** `graphql-ws` protocol on `/graphql` (the same path as HTTP), via `@nestjs/apollo`.
- **Connection auth:** the access token goes in `connectionParams.authorization` at `connection_init` (never in the URL, which lands in proxy logs). Invalid → closed with 4403.
  - The session is re-checked every 60s; if revoked, the socket is closed with **4401** and the client refreshes and reconnects.
  - Each subscription also runs through the normal auth guard.
- **Authorization:** ownership is checked when the subscription starts (`accountUpdated` → `AccountsService.getOwned`; `simulatedOrderUpdated` → the caller's portfolio). Every event is then filtered by aggregate id **and** owner id, defense in depth.
- **Fan-out:** one Redis subscriber connection per API instance feeds an in-process `EventEmitter`. Each subscription is an async iterator that unsubscribes when the client leaves. Duplicate event ids are dropped.
- **Subscriptions:**
  - `accountUpdated(accountId)`: the account (balance **re-read from Postgres**, not trusted from the event) plus the new statement line. The `Transaction` id matches the query's, so Apollo's normalized cache merges it.
  - `simulatedOrderUpdated(portfolioId)`: the full order, re-read.
  - `marketPriceUpdated(assetIds ≤ 50, minIntervalMs)`: only the requested assets, throttled per asset per subscription (≥1s; e.g. ~5s for lists), on top of the ingestion-side 1 msg/asset/s cap. No client gets every tick of every asset.
- **Recovery:** each payload carries a gapless `sequence`. On reconnect or gap, the client calls `missedEvents(stream, afterSequence)` (durable outbox) or refetches the query. Snapshot reconciliation wins over event replay when in doubt.
- **Errors:** Apollo's `formatError` doesn't run on WebSockets, so `onNext` applies the same whitelist (AppError codes pass; everything else is masked and logged).

## Consequences
- Subscriptions are per-instance; Redis pub/sub connects instances. Horizontal scaling works without sticky sessions.
- Event payloads are hints; authoritative data is re-read per delivery (one primary-key query per event per subscriber). Batch with DataLoader if subscriber counts grow.
