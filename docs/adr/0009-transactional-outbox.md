# ADR 0009: Transactional outbox, at-least-once delivery

**Status:** accepted (Milestone 8)

## Context
Clients need real-time notice of balance changes and order updates. Publishing to Redis or WebSockets from inside a database transaction is wrong both ways: a rollback after publishing announces something that never happened; a crash after commit loses the announcement.

## Decision
- **Outbox table** `outbox_events`, written with the **same transaction client** as the state change (`LedgerService.post` for every customer account touched, `OrdersService` for every order change). The event exists if and only if the change committed.
- **Versioned contracts:** `{ id (UUIDv7), type, version, aggregateType, aggregateId, sequence, occurredAt, correlationId, payload }`.
  - `AccountBalanceChanged` v1.
  - `SimulatedOrderUpdated` v1.
  - Breaking payload changes get a new version.
- **Gapless per-aggregate sequence.** `accounts.version` / `portfolios.version` are incremented in the same transaction, under the row lock that transaction already holds, and used as the sequence. `UNIQUE (aggregate_type, aggregate_id, sequence)`.
- **Publisher worker** (in-process, every 250ms):
  - `SELECT … FOR UPDATE SKIP LOCKED` batches. Several instances can publish in parallel without taking the same rows.
  - Publishes to `events:<aggregate>` on Redis, then marks `published_at`.
  - **Per-aggregate order:** an event is only eligible when every earlier event of its aggregate is published or dead (`NOT EXISTS`). One stuck event blocks its own aggregate, never others.
  - **Retries** with exponential backoff and jitter (0.5s → 5 min). After 12 attempts the event is **dead-lettered** (`failed_at`) and logged at error level.
  - **Crash/restart:** pending rows simply wait in the table; the next run picks them up.
  - Backlog stats (pending, dead, oldest age) are logged every 30s while non-zero.
  - Published events are kept 30 days as the replay source.
- **Delivery guarantee: at-least-once.** A crash between publish and mark republishes. Consumers dedupe on event `id` (the event bus keeps a 10k-id window) and order/gap-check on `sequence`. Exactly-once is not claimed.
- **Redis pub/sub is at-most-once to subscribers** (messages published while a subscriber is disconnected are lost). Recovery comes from the durable table via the `missedEvents` query, plus refetching authoritative state.

## Alternatives considered
- **Publish after commit in application code** (no outbox). Simple, but loses events on a crash between commit and publish.
- **Logical decoding / CDC (Debezium).** Robust and no polling, but heavy infrastructure for a modular monolith.
- **Redis Streams or Kafka as the durable log.** Better consumer-group semantics; adds a second source of truth. The Postgres table is already durable and transactional.
- **LISTEN/NOTIFY to wake the worker.** Lower latency than 250ms polling; not needed yet.

## Consequences
- Events are published in the order their aggregates allow, with up to ~250ms extra latency.
- A dead-lettered event leaves a sequence gap; clients see the gap and resync from queries.
- The publisher holds a short transaction while publishing a batch (≤100 events). Move to a claim/lease column if Redis latency ever makes that long.
