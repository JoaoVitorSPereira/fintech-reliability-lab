import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthReport, HealthStatus } from './health.model';
import { HealthService } from './health.service';

// Plain HTTP for load balancers/orchestrators. Not product API, so no OpenAPI.
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Liveness: is the process able to answer at all? No dependency checks, a
  // DB outage must not trigger a restart loop.
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness: should this instance receive traffic right now?
  @Get('ready')
  async ready(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status !== HealthStatus.OK) {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
