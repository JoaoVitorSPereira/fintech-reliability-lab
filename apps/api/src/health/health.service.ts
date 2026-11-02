import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { REDIS } from '../infrastructure/redis/redis.module';
import { DependencyStatus, HealthReport, HealthStatus } from './health.model';

const PROBE_TIMEOUT_MS = 1_000;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectPinoLogger(HealthService.name) private readonly logger: PinoLogger,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([
      this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.probe('redis', () => this.redis.ping()),
    ]);
    const allUp =
      database === DependencyStatus.UP && redis === DependencyStatus.UP;

    return {
      status: allUp ? HealthStatus.OK : HealthStatus.DEGRADED,
      database,
      redis,
      checkedAt: new Date(),
    };
  }

  // A hung dependency must not hang the probe: the orchestrator would just
  // time out with no information.
  private async probe(
    name: string,
    check: () => Promise<unknown>,
  ): Promise<DependencyStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)),
        PROBE_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([check(), timeout]);
      return DependencyStatus.UP;
    } catch (error) {
      this.logger.warn(
        { dependency: name, err: (error as Error).message },
        'health probe failed',
      );
      return DependencyStatus.DOWN;
    } finally {
      clearTimeout(timer);
    }
  }
}
