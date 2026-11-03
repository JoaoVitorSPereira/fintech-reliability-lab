import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { TradingModule } from '../trading/trading.module';
import { RealtimeResolver } from './realtime.resolver';

@Module({
  imports: [AccountsModule, TradingModule],
  providers: [RealtimeResolver],
})
export class RealtimeModule {}
