import { DocumentBuilder } from '@nestjs/swagger';

export function openApiConfig() {
  return new DocumentBuilder()
    .setTitle('Fintech Reliability Lab: REST endpoints')
    .setDescription(
      'Operational endpoints only. The product API is GraphQL at /graphql (schema in apps/api/schema.graphql).',
    )
    .setVersion('1.0')
    .build();
}
