-- CreateEnum
CREATE TYPE "account_kind" AS ENUM ('CUSTOMER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ledger_transaction_kind" AS ENUM ('DEPOSIT');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "kind" "account_kind" NOT NULL,
    "system_code" TEXT,
    "currency" CHAR(3) NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "kind" "ledger_transaction_kind" NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_system_code_key" ON "accounts"("system_code");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_id_currency_key" ON "accounts"("id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_id_idx" ON "ledger_entries"("account_id", "id");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_currency_fkey" FOREIGN KEY ("account_id", "currency") REFERENCES "accounts"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants. Prisma's schema language can't express these;
-- `prisma migrate diff` ignores them, so they are never dropped by later
-- migrations. See docs/adr/0005-double-entry-ledger.md.
-- ---------------------------------------------------------------------------

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- The database refuses an overdraft even if application code is wrong.
  ADD CONSTRAINT "accounts_customer_non_negative" CHECK ("kind" = 'SYSTEM' OR "balance" >= 0),
  ADD CONSTRAINT "accounts_owner_matches_kind" CHECK (("kind" = 'CUSTOMER') = ("user_id" IS NOT NULL)),
  ADD CONSTRAINT "accounts_system_code_matches_kind" CHECK (("kind" = 'SYSTEM') = ("system_code" IS NOT NULL));

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_non_zero" CHECK ("amount" <> 0);

-- 1. Immutability: corrections are new reversal transactions, never edits.
CREATE FUNCTION ledger_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();
CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON "ledger_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();

-- 2. Cached balance. A relative update (balance + amount) under the row lock
--    the UPDATE takes, so concurrent postings serialize per account and the
--    CHECK above sees the real result.
CREATE FUNCTION ledger_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "accounts" SET "balance" = "balance" + NEW."amount" WHERE "id" = NEW."account_id";
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_entries_apply_balance
  AFTER INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry();

-- 3. Balanced transactions, checked at COMMIT (entries are inserted one at a
--    time, so the transaction is legitimately unbalanced in between).
CREATE FUNCTION ledger_assert_balanced(tx_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM "ledger_entries" WHERE "transaction_id" = tx_id) < 2 THEN
    RAISE EXCEPTION 'ledger transaction % needs at least two entries', tx_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ledger_entries" WHERE "transaction_id" = tx_id
    GROUP BY "currency" HAVING sum("amount") <> 0
  ) THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced', tx_id
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION ledger_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW."transaction_id");
  RETURN NULL;
END $$;

CREATE FUNCTION ledger_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW."id");
  RETURN NULL;
END $$;

-- Two triggers: one catches a header with no entries, the other catches
-- entries added later to an already-committed transaction.
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON "ledger_entries" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_balanced();
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON "ledger_transactions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balanced();

-- 4. Accounts can't change currency, owner or kind after opening (history
--    would stop making sense). Balance changes only through the trigger above.
CREATE FUNCTION accounts_guard_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currency" <> OLD."currency" OR NEW."kind" <> OLD."kind"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_identity_immutable
  BEFORE UPDATE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_identity();

-- The counterparty for money entering or leaving the platform.
INSERT INTO "accounts" ("id", "kind", "system_code", "currency")
VALUES (gen_random_uuid(), 'SYSTEM', 'external-funding:BRL', 'BRL');
