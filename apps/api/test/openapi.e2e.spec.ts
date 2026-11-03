import type { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type { App } from 'supertest/types';
import { openApiConfig } from '../src/openapi';
import { createTestApp } from './graphql';

describe('OpenAPI document', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents the health endpoints and hides /metrics', () => {
    const document = SwaggerModule.createDocument(app, openApiConfig());
    expect(Object.keys(document.paths).sort()).toEqual([
      '/health/live',
      '/health/ready',
    ]);
    expect(document.paths['/health/ready']?.get?.responses).toHaveProperty(
      '503',
    );
  });
});
