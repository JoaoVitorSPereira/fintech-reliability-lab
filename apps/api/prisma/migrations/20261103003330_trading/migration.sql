-- CreateEnum
CREATE TYPE "account_purpose" AS ENUM ('CHECKING', 'PORTFOLIO_CASH', 'PORTFOLIO_RESERVED');

-- CreateEnum
CREATE TYPE "order_side" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "order_type" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('PENDING', 'FILLED', 'CANCELLED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ledger_transaction_kind" ADD VALUE 'TRADE';
ALTER TYPE "ledger_transaction_kind" ADD VALUE 'ORDER_HOLD';
ALTER TYPE "ledger_transaction_kind" ADD VALUE 'ORDER_RELEASE';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "purpose" "account_purpose";

-- CreateTable
CREATE TABLE "portfolios" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "cash_account_id" UUID NOT NULL,
    "reserved_account_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "portfolio_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "reserved_quantity" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "cost_basis" DECIMAL(38,8) NOT NULL,
    "realized_pnl" DECIMAL(38,8) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("portfolio_id","asset_id")
);

-- CreateTable
CREATE TABLE "simulated_orders" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "side" "order_side" NOT NULL,
    "type" "order_type" NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "limit_price" DECIMAL(38,12),
    "status" "order_status" NOT NULL,
    "reject_reason" TEXT,
    "reserved_cash_minor" BIGINT NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "filled_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "simulated_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "side" "order_side" NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(38,12) NOT NULL,
    "notional_minor" BIGINT NOT NULL,
    "realized_pnl" DECIMAL(38,8),
    "price_provider" TEXT NOT NULL,
    "price_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "ledger_transaction_id" UUID NOT NULL,
    "executed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_valuations" (
    "portfolio_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "total_value" DECIMAL(38,8) NOT NULL,
    "is_stale" BOOLEAN NOT NULL,

    CONSTRAINT "portfolio_valuations_pkey" PRIMARY KEY ("portfolio_id","at")
);

-- CreateTable
CREATE TABLE "watchlist_items" (
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("user_id","asset_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_user_id_key" ON "portfolios"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_cash_account_id_key" ON "portfolios"("cash_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_reserved_account_id_key" ON "portfolios"("reserved_account_id");

-- CreateIndex
CREATE INDEX "simulated_orders_portfolio_id_id_idx" ON "simulated_orders"("portfolio_id", "id");

-- CreateIndex
CREATE INDEX "simulated_orders_status_type_idx" ON "simulated_orders"("status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "simulated_orders_user_id_idempotency_key_key" ON "simulated_orders"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "trades_order_id_key" ON "trades"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_ledger_transaction_id_key" ON "trades"("ledger_transaction_id");

-- CreateIndex
CREATE INDEX "trades_portfolio_id_id_idx" ON "trades"("portfolio_id", "id");

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_reserved_account_id_fkey" FOREIGN KEY ("reserved_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "simulated_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_ledger_transaction_id_fkey" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_valuations" ADD CONSTRAINT "portfolio_valuations_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written (see docs/adr/0008-simulated-trading.md)
-- ---------------------------------------------------------------------------

-- Existing customer accounts are all checking accounts. The identity guard
-- is replaced below; until then it doesn't look at purpose.
UPDATE "accounts" SET "purpose" = 'CHECKING' WHERE "kind" = 'CUSTOMER';
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_purpose_matches_kind" CHECK (("kind" = 'SYSTEM') = ("purpose" IS NULL));

CREATE OR REPLACE FUNCTION accounts_guard_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currency" <> OLD."currency" OR NEW."kind" <> OLD."kind"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose" THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_quantity_non_negative" CHECK ("quantity" >= 0),
  ADD CONSTRAINT "positions_reserved_within_quantity" CHECK ("reserved_quantity" >= 0 AND "reserved_quantity" <= "quantity"),
  ADD CONSTRAINT "positions_cost_basis_non_negative" CHECK ("cost_basis" >= 0),
  ADD CONSTRAINT "positions_flat_has_no_cost" CHECK ("quantity" > 0 OR "cost_basis" = 0);

ALTER TABLE "simulated_orders"
  ADD CONSTRAINT "orders_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "orders_limit_price_matches_type" CHECK (("type" = 'LIMIT') = ("limit_price" IS NOT NULL)),
  ADD CONSTRAINT "orders_limit_price_positive" CHECK ("limit_price" IS NULL OR "limit_price" > 0),
  ADD CONSTRAINT "orders_reserved_cash_non_negative" CHECK ("reserved_cash_minor" >= 0),
  ADD CONSTRAINT "orders_reject_reason_matches_status" CHECK (("status" = 'REJECTED') = ("reject_reason" IS NOT NULL)),
  ADD CONSTRAINT "orders_filled_at_matches_status" CHECK (("status" = 'FILLED') = ("filled_at" IS NOT NULL)),
  ADD CONSTRAINT "orders_cancelled_at_matches_status" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
  ADD CONSTRAINT "orders_idempotency_key_format" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{8,100}$');

-- Orders only move forward: PENDING -> FILLED | CANCELLED; final states are final.
CREATE FUNCTION orders_guard_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'order % is % and cannot become %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."side" <> OLD."side" OR NEW."type" <> OLD."type" OR NEW."quantity" <> OLD."quantity"
     OR NEW."limit_price" IS DISTINCT FROM OLD."limit_price" OR NEW."asset_id" <> OLD."asset_id" THEN
    RAISE EXCEPTION 'order terms are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER simulated_orders_transition
  BEFORE UPDATE ON "simulated_orders"
  FOR EACH ROW EXECUTE FUNCTION orders_guard_transition();

ALTER TABLE "trades"
  ADD CONSTRAINT "trades_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "trades_price_positive" CHECK ("price" > 0),
  ADD CONSTRAINT "trades_notional_positive" CHECK ("notional_minor" > 0);
ALTER TABLE "trades" ALTER CONSTRAINT "trades_ledger_transaction_id_fkey" DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER trades_append_only
  BEFORE UPDATE OR DELETE ON "trades"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();

-- Counterparty for simulated trade settlement. Goes negative/positive as
-- users buy/sell: it is "the market", not anyone's money.
INSERT INTO "accounts" ("id", "kind", "system_code", "currency")
VALUES (gen_random_uuid(), 'SYSTEM', 'simulated-market:USD', 'USD');
