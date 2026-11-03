import { Injectable, Scope } from '@nestjs/common';
import DataLoader from 'dataloader';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { StoredQuote } from './market-data.types';
import { Metrics } from '../../infrastructure/metrics/metrics';
import { MarketDataService, type Volatility } from './market-data.service';
import { QuoteStore } from './quote-store';

const SPARKLINE_HOURS = 24;

// Request-scoped: a DataLoader caches per request, never across users.
// Without these, a list of 25 assets costs 25 Redis round trips for quotes
// and 25 SQL queries for sparklines (the N+1 problem). With them: 1 + 1.
@Injectable({ scope: Scope.REQUEST })
export class MarketDataLoaders {
  constructor(
    private readonly quoteStore: QuoteStore,
    private readonly prisma: PrismaService,
    private readonly metrics: Metrics,
    private readonly marketData: MarketDataService,
  ) {}

  readonly volatility = new DataLoader<string, Volatility | null>(
    async (assetIds) => {
      this.metrics.dataloaderBatchSize.observe(
        { loader: 'volatility' },
        assetIds.length,
      );
      const found = await this.marketData.volatility(assetIds);
      return assetIds.map((id) => found.get(id) ?? null);
    },
  );

  readonly quotes = new DataLoader<string, StoredQuote | null>(
    async (assetIds) => {
      this.metrics.dataloaderBatchSize.observe(
        { loader: 'quotes' },
        assetIds.length,
      );
      const found = await this.quoteStore.readMany(assetIds);
      return assetIds.map((id) => found.get(id) ?? null);
    },
  );

  readonly sparklines = new DataLoader<string, string[]>(async (assetIds) => {
    this.metrics.dataloaderBatchSize.observe(
      { loader: 'sparklines' },
      assetIds.length,
    );
    const rows = await this.prisma.$queryRaw<
      { asset_id: string; close: Prisma.Decimal }[]
    >`
      SELECT asset_id, close FROM candles
      WHERE asset_id = ANY(${[...assetIds]}::uuid[])
        AND timeframe = 'H1'
        AND open_time >= now() - make_interval(hours => ${SPARKLINE_HOURS})
      ORDER BY asset_id, open_time`;
    const byAsset = new Map<string, string[]>();
    for (const row of rows) {
      const series = byAsset.get(row.asset_id) ?? [];
      series.push(row.close.toFixed());
      byAsset.set(row.asset_id, series);
    }
    return assetIds.map((id) => byAsset.get(id) ?? []);
  });
}
