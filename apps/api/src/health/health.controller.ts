import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../modules/identity/auth.guard';
import { HealthReport, HealthStatus } from './health.model';
import { HealthService } from './health.service';

// Plain HTTP for load balancers/orchestrators. The product API is GraphQL;
// these are the only intentional REST endpoints, documented with OpenAPI.
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Liveness: is the process able to answer at all? No dependency checks, a
  // DB outage must not trigger a restart loop.
  @Get('live')
  @ApiOperation({
    summary: 'Liveness: the process can answer. Never checks dependencies.',
  })
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  live() {
    return { status: 'ok' };
  }

  // Readiness: should this instance receive traffic right now?
  @Get('ready')
  @ApiOperation({
    summary:
      'Readiness: Postgres and Redis reachable, so this instance should get traffic.',
  })
  @ApiOkResponse({ type: HealthReport })
  @ApiServiceUnavailableResponse({
    description: 'A dependency is down; the body says which.',
  })
  async ready(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status !== HealthStatus.OK) {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
