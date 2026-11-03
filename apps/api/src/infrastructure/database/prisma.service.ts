import {
  Global,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { Env } from '../../config/env';
import { Metrics } from '../metrics/metrics';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnApplicationShutdown
{
  constructor(config: ConfigService<Env, true>, metrics: Metrics) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        // pg's default is "wait forever" for a pool connection.
        connectionTimeoutMillis: 5_000,
      }),
      log: [{ emit: 'event', level: 'query' }],
    });
    // Statement durations only: the SQL text and parameters are not recorded.
    (
      this as unknown as {
        $on(event: 'query', cb: (e: { duration: number }) => void): void;
      }
    ).$on('query', (event) =>
      metrics.dbQueryDuration.observe(event.duration / 1000),
    );
  }

  async onApplicationShutdown() {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DatabaseModule {}
