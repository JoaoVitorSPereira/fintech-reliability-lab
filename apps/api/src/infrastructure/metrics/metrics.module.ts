import {
  Controller,
  ForbiddenException,
  Get,
  Global,
  Header,
  Headers,
  Module,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Env } from '../../config/env';
import { Public } from '../../modules/identity/auth.guard';
import { Metrics } from './metrics';

// Scraped by Prometheus. Not part of the public API: block it at the
// ingress, and/or set METRICS_TOKEN so scrapes need a bearer token.
@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: Metrics,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  async scrape(
    @Headers('authorization') authorization?: string,
  ): Promise<string> {
    const token = this.config.get('METRICS_TOKEN', { infer: true });
    if (token && authorization !== `Bearer ${token}`)
      throw new ForbiddenException();
    return this.metrics.registry.metrics();
  }
}

@Global()
@Module({
  providers: [{ provide: Metrics, useFactory: () => new Metrics() }],
  controllers: [MetricsController],
  exports: [Metrics],
})
export class MetricsModule {}
