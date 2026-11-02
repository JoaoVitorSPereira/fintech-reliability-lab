# ADR 0002: Prisma ORM, with raw SQL for row locking

**Status:** accepted (Milestone 1, applies from Milestone 4)

## Context
Transfers and order execution need pessimistic row locks (`SELECT … FOR UPDATE`), explicit isolation levels, and constraint-backed invariants. Prisma's query API supports interactive transactions and isolation levels but has no row-locking API. SQL-first tools (Kysely, Drizzle) express locks natively.

## Decision
Keep Prisma 7 (driver adapter `@prisma/adapter-pg`) for schema, migrations, and ordinary queries. Locking reads on the financial critical path use `$queryRaw` inside `$transaction`, in the infrastructure repositories. This is visible and documented, not hidden behind an abstraction.

## Consequences
- Migrations and most data access keep Prisma's types and DX.
- The most important SQL in the system is hand-written and must be covered by integration tests against real Postgres (concurrency tests, not mocks).
- Invariants that must never break (balanced entries, non-negative balances, unique idempotency keys) are enforced by database constraints, not only by application code.
