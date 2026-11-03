-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "failed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_aggregate_type_aggregate_id_sequence_key" ON "outbox_events"("aggregate_type", "aggregate_id", "sequence");

-- Hand-written (see docs/adr/0009-transactional-outbox.md)
-- The publisher's hot query: unpublished, not dead, due.
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("next_attempt_at", "occurred_at")
  WHERE "published_at" IS NULL AND "failed_at" IS NULL;
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_sequence_positive" CHECK ("sequence" > 0),
  ADD CONSTRAINT "outbox_events_attempts_non_negative" CHECK ("attempts" >= 0);
