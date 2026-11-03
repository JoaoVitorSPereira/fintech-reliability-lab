import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';

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
  @ApiProperty({ enum: HealthStatus })
  @Field(() => HealthStatus)
  status: HealthStatus;

  @ApiProperty({ enum: DependencyStatus })
  @Field(() => DependencyStatus)
  database: DependencyStatus;

  @ApiProperty({ enum: DependencyStatus })
  @Field(() => DependencyStatus)
  redis: DependencyStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  @Field()
  checkedAt: Date;
}
