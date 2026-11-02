import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum DependencyStatus {
  UP = 'UP',
  DOWN = 'DOWN',
}

export enum HealthStatus {
  OK = 'OK',
  DEGRADED = 'DEGRADED',
}

registerEnumType(DependencyStatus, { name: 'DependencyStatus' });
registerEnumType(HealthStatus, { name: 'HealthStatus' });

@ObjectType('Health')
export class HealthReport {
  @Field(() => HealthStatus)
  status: HealthStatus;

  @Field(() => DependencyStatus)
  database: DependencyStatus;

  @Field(() => DependencyStatus)
  redis: DependencyStatus;

  @Field()
  checkedAt: Date;
}
