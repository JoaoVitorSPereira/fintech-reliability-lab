import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp, gql, registerUser } from './graphql';

describe('Metrics endpoint', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exports the operational metrics, with no user data in labels', async () => {
    const user = await registerUser(app);
    await gql(app, '{ accounts { id } }', {}, user.accessToken);
    await gql(
      app,
      `mutation L($input: LoginInput!) { login(input: $input) { accessToken } }`,
      {
        input: {
          email: `nobody-${crypto.randomUUID()}@example.com`,
          password: 'wrong password here',
        },
      },
    );

    const res = await request(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(200);
    for (const name of [
      'graphql_operation_duration_seconds',
      'graphql_resolver_duration_seconds',
      'db_query_duration_seconds',
      'auth_failures_total',
      'outbox_pending_events',
      'ws_connections',
      'market_provider_rate_limited_total',
      'financial_operation_failures_total',
    ]) {
      expect(res.text).toContain(name);
    }
    expect(res.text).toMatch(
      /graphql_resolver_duration_seconds_count\{field="Query\.accounts"\}/,
    );
    expect(res.text).toMatch(
      /auth_failures_total\{reason="invalid_credentials"\} [1-9]/,
    );
    // Nothing identifying: no emails, no UUIDs, no tokens.
    expect(res.text).not.toMatch(/@example\.com/);
    expect(res.text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    expect(res.text).not.toContain(user.accessToken);
  });
});
