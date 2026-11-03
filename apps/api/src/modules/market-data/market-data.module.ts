import { Module } from '@nestjs/common';
import { MarketIngestionService } from './ingestion/market-ingestion.service';
import { MarketDataLoaders } from './market-data.loaders';
import { marketDataProviders } from './market-data.providers';
import { MarketDataResolver } from './market-data.resolver';
import { MarketDataService } from './market-data.service';
import { QuoteStore } from './quote-store';

@Module({
  providers: [
    ...marketDataProviders,
    QuoteStore,
    MarketDataService,
    MarketDataLoaders,
    MarketDataResolver,
    MarketIngestionService,
  ],
  exports: [MarketDataService, QuoteStore, MarketIngestionService],
})
export class MarketDataModule {}
