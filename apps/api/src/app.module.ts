import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env';
import { graphqlConfig } from './graphql/graphql.config';
import { GraphqlLoggingPlugin } from './graphql/logging.plugin';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/prisma.service';
import { loggerConfig } from './infrastructure/logging/logger.config';
import { RedisModule } from './infrastructure/redis/redis.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { EventsModule } from './modules/events/events.module';
import { AuthService } from './modules/identity/auth.service';
import { IdentityModule } from './modules/identity/identity.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { TransfersModule } from './modules/transfers/transfers.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { TradingModule } from './modules/trading/trading.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AppErrorFilter } from './shared/errors/app-error.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: loggerConfig,
    }),
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [IdentityModule],
      inject: [ConfigService, AuthService],
      useFactory: graphqlConfig,
    }),
    DatabaseModule,
    RedisModule,
    EventsModule,
    HealthModule,
    IdentityModule,
    LedgerModule,
    AccountsModule,
    TransfersModule,
    MarketDataModule,
    TradingModule,
    RealtimeModule,
  ],
  providers: [
    GraphqlLoggingPlugin,
    { provide: APP_FILTER, useClass: AppErrorFilter },
  ],
})
export class AppModule {}
