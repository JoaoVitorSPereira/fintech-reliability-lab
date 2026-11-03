-- CreateEnum
CREATE TYPE "transfer_kind" AS ENUM ('TRANSFER', 'SIMULATED_DEPOSIT');

-- AlterEnum
ALTER TYPE "ledger_transaction_kind" ADD VALUE 'TRANSFER';

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "transfer_kind" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "from_account_id" UUID NOT NULL,
    "to_account_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "description" TEXT NOT NULL,
    "ledger_transaction_id" UUID NOT NULL,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transfers_ledger_transaction_id_key" ON "transfers"("ledger_transaction_id");

-- CreateIndex
CREATE INDEX "transfers_from_account_id_idx" ON "transfers"("from_account_id");

-- CreateIndex
CREATE INDEX "transfers_to_account_id_idx" ON "transfers"("to_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_user_id_idempotency_key_key" ON "transfers"("user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_ledger_transaction_id_fkey" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written (see docs/adr/0006-transfers-and-idempotency.md)
-- ---------------------------------------------------------------------------

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "transfers_distinct_accounts" CHECK ("from_account_id" <> "to_account_id"),
  ADD CONSTRAINT "transfers_idempotency_key_format" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{8,100}$');

-- The transfer row is inserted FIRST (it is the idempotency claim: a
-- concurrent duplicate blocks on the unique index right there), before the
-- ledger transaction it points to exists. Deferring the FK to COMMIT allows
-- that order while still guaranteeing the ledger transaction exists.
ALTER TABLE "transfers" ALTER CONSTRAINT "transfers_ledger_transaction_id_fkey" DEFERRABLE INITIALLY DEFERRED;

-- Audit records are append-only, like the ledger.
CREATE TRIGGER transfers_append_only
  BEFORE UPDATE OR DELETE ON "transfers"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();

INSERT INTO "accounts" ("id", "kind", "system_code", "currency")
VALUES (gen_random_uuid(), 'SYSTEM', 'external-funding:USD', 'USD');
