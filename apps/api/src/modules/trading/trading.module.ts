import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { OrdersService } from './orders.service';
import { PortfolioService } from './portfolio.service';
import { TradingJobs } from './trading-jobs.service';
import { TradingResolver } from './trading.resolver';
import { WatchlistService } from './watchlist.service';

@Module({
  imports: [AccountsModule, MarketDataModule],
  providers: [
    OrdersService,
    PortfolioService,
    WatchlistService,
    TradingResolver,
    TradingJobs,
  ],
  exports: [OrdersService, PortfolioService],
})
export class TradingModule {}
