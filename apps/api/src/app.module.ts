import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env';
import { graphqlConfig } from './graphql/graphql.config';
import { GraphqlLoggingPlugin } from './graphql/logging.plugin';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/prisma.service';
import { loggerConfig } from './infrastructure/logging/logger.config';
import { RedisModule } from './infrastructure/redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: loggerConfig,
    }),
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [ConfigService],
      useFactory: graphqlConfig,
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
  ],
  providers: [GraphqlLoggingPlugin],
})
export class AppModule {}
