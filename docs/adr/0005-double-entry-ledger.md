# ADR 0005: Double-entry ledger with database-enforced invariants

**Status:** accepted (Milestone 3)

## Context
Balances must be auditable, corrections must not destroy history, and a bug must never create or destroy money. Concurrent requests must not overdraw an account.

## Decision
- **Double entry.** Every movement is a `ledger_transactions` row with ≥2 `ledger_entries`. Amounts are signed (positive = money into that account) and sum to zero per currency.
- **Money = `BIGINT` minor units**, `bigint` in TypeScript, a decimal string on the GraphQL wire (`Money { amount: "1050.25", currency }`). Crypto quantities (Milestone 7) use `NUMERIC`, because 18-decimal assets overflow `BIGINT`.
- **Cached balance** on `accounts.balance`, maintained by an `AFTER INSERT` trigger on entries (`balance = balance + amount`). This makes `CHECK (kind = 'SYSTEM' OR balance >= 0)` possible: the database refuses an overdraft even if application code is wrong.
- **Deferred constraint triggers** check at `COMMIT` that each transaction has ≥2 entries and balances per currency.
- **Append-only.** Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on ledger tables. Mistakes are fixed with reversal transactions.
- **Currency consistency** through a composite FK `(account_id, currency) → accounts(id, currency)`. Account currency, kind and owner are immutable (trigger).
- **System accounts** (`external-funding:BRL`, …) represent the outside world and may go negative. `SUM(all entries) = 0` per currency is the global integrity check.
- **Reconciliation:** `LedgerService.verifyIntegrity()` compares every cached balance to `SUM(entries)` and checks the global sum.

## Alternatives considered
- **Balance column only, no ledger.** No audit trail, no way to detect corruption. Rejected.
- **Always compute `SUM(entries)`.** Never drifts, but reads grow with history and an aggregate can't carry a CHECK constraint. Rejected.
- **Maintain the balance in application code.** Visible, but any code path that forgets it drifts. The trigger plus the reconciliation check is safer.
- **Debit/credit columns.** Conventional for accountants, but signed amounts make "sums to zero" a plain `SUM()`.
- **`NUMERIC` for cash.** Exact but slower, and Prisma's `Decimal` would spread through the code. `BIGINT` is enough for fiat.

## Consequences
- Business logic lives partly in SQL (triggers). It's covered by tests that bypass the application and write raw SQL.
- Fixing bad data means posting corrections, never editing rows. (This happened for real: a mutation test left three overdrawn test accounts, fixed with a correcting transaction.)
- The trigger's `UPDATE accounts` takes the row lock, so writes to one account serialize. That's the point, and it caps the throughput of a single hot account. Shard hot system accounts if that ever matters.
