import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { REDIS } from '../src/infrastructure/redis/redis.module';

// Runs against the real Postgres and Redis from docker-compose (or CI services).
// Mocks here would prove nothing about the wiring this milestone is about.
describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live answers without checking dependencies', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200, { status: 'ok' });
  });

  it('GET /health/ready reports both dependencies up', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(res.body).toMatchObject({
      status: 'OK',
      database: 'UP',
      redis: 'UP',
    });
  });

  it('answers the health query over GraphQL', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: '{ health { status database redis checkedAt } }' })
      .expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.health).toMatchObject({
      status: 'OK',
      database: 'UP',
      redis: 'UP',
    });
    expect(Number.isNaN(Date.parse(res.body.data.health.checkedAt))).toBe(
      false,
    );
  });

  it('echoes a well-formed x-request-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'mobile-abc_123')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('mobile-abc_123');
  });

  it('replaces a malformed or oversized x-request-id', async () => {
    for (const bad of ['has spaces', 'a'.repeat(65), '"level":"fatal"']) {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('x-request-id', bad)
        .expect(200);

      expect(res.headers['x-request-id']).not.toBe(bad);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('Health (e2e) with Redis down', () => {
  let app: INestApplication<App>;

  // Every command fails, like a client whose server is unreachable.
  function downRedis(): Record<string, unknown> {
    const refused = () => Promise.reject(new Error('connection refused'));
    return {
      ping: refused,
      subscribe: refused,
      publish: refused,
      on: () => undefined,
      quit: () => Promise.resolve('OK'),
      duplicate: () => downRedis(),
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS)
      .useValue(downRedis())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/ready returns 503 and says which dependency failed', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);

    expect(res.body).toMatchObject({
      status: 'DEGRADED',
      database: 'UP',
      redis: 'DOWN',
    });
  });

  it('liveness stays 200, so the orchestrator does not restart the pod', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
