-- CreateEnum
CREATE TYPE "asset_category" AS ENUM ('CRYPTO', 'STOCK', 'ETF');

-- CreateEnum
CREATE TYPE "chart_timeframe" AS ENUM ('M1', 'M5', 'M15', 'H1', 'H4', 'D1', 'W1', 'MN1');

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "category" "asset_category" NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "logo_url" TEXT,
    "market_cap_rank" INTEGER,
    "coingecko_id" TEXT,
    "binance_symbol" TEXT,
    "twelve_data_symbol" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candles" (
    "asset_id" UUID NOT NULL,
    "timeframe" "chart_timeframe" NOT NULL,
    "open_time" TIMESTAMPTZ(3) NOT NULL,
    "open" DECIMAL(38,12) NOT NULL,
    "high" DECIMAL(38,12) NOT NULL,
    "low" DECIMAL(38,12) NOT NULL,
    "close" DECIMAL(38,12) NOT NULL,
    "volume" DECIMAL(38,12) NOT NULL,
    "provider" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("asset_id","timeframe","open_time")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_coingecko_id_key" ON "assets"("coingecko_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_binance_symbol_key" ON "assets"("binance_symbol");

-- CreateIndex
CREATE UNIQUE INDEX "assets_twelve_data_symbol_key" ON "assets"("twelve_data_symbol");

-- CreateIndex
CREATE UNIQUE INDEX "assets_category_symbol_key" ON "assets"("category", "symbol");

-- AddForeignKey
ALTER TABLE "candles" ADD CONSTRAINT "candles_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written
ALTER TABLE "candles"
  ADD CONSTRAINT "candles_ohlc_consistent" CHECK ("low" <= "open" AND "low" <= "close" AND "high" >= "open" AND "high" >= "close" AND "low" >= 0),
  ADD CONSTRAINT "candles_volume_non_negative" CHECK ("volume" >= 0);
