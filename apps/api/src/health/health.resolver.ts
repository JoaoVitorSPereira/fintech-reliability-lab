import { Query, Resolver } from '@nestjs/graphql';
import { Public } from '../modules/identity/auth.guard';
import { HealthReport } from './health.model';
import { HealthService } from './health.service';

@Resolver(() => HealthReport)
export class HealthResolver {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Query(() => HealthReport)
  health(): Promise<HealthReport> {
    return this.healthService.check();
  }
}
