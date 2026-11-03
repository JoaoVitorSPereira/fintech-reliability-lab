import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { type ValidationRule, parse, specifiedRules, validate } from 'graphql';
import request from 'supertest';
import type { App } from 'supertest/types';
import { graphqlConfig } from '../src/graphql/graphql.config';
import { AuthService } from '../src/modules/identity/auth.service';
import { createTestApp, registerUser } from './graphql';

// The mobile app's real operations, read from its source, must pass the
// same validation rules the server applies (depth, cost, aliases).
function mobileDocuments(): { name: string; source: string }[] {
  const file = readFileSync(
    join(__dirname, '../../mobile/src/graphql/operations.ts'),
    'utf8',
  );
  const all = [
    ...file.matchAll(/export const (\w+) = graphql\(`([\s\S]*?)`\);/g),
  ].map(([, name, source]) => ({ name: name!, source: source! }));
  const fragments = all
    .filter((d) => d.source.trim().startsWith('fragment'))
    .map((d) => d.source)
    .join('\n');
  return all
    .filter((d) => !d.source.trim().startsWith('fragment'))
    .map((d) => ({ name: d.name, source: `${d.source}\n${fragments}` }));
}

describe('GraphQL query limits', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    token = (await registerUser(app)).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(mobileDocuments().map((d) => [d.name, d.source]))(
    'mobile operation %s passes depth, cost and alias limits',
    (_name, source) => {
      const schema = app.get(GraphQLSchemaHost).schema;
      const rules = graphqlConfig(app.get(ConfigService), app.get(AuthService))
        .validationRules as ValidationRule[];
      const document = parse(source);
      // Unused fragments are fine here: each document gets every fragment appended.
      const errors = validate(schema, document, [
        ...specifiedRules.filter(
          (rule) => rule.name !== 'NoUnusedFragmentsRule',
        ),
        ...rules,
      ]);
      expect(errors.map((e) => e.message)).toEqual([]);
    },
  );

  async function post(query: string) {
    return request(app.getHttpServer())
      .post('/graphql')
      .set('authorization', `Bearer ${token}`)
      .send({ query });
  }

  it('rejects a query with too many aliases as a 400 validation error', async () => {
    const aliases = Array.from(
      { length: 20 },
      (_, i) => `a${i}: me { id }`,
    ).join(' ');
    const res = await post(`{ ${aliases} }`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].extensions.code).toBe(
      'GRAPHQL_VALIDATION_FAILED',
    );
  });

  it('rejects an expensive wide query as a 400 validation error', async () => {
    const wide = Array.from(
      { length: 14 },
      (_, i) =>
        `w${i}: assets(first: 100) { nodes { id symbol name quote { price change24h volume24h marketCap provider } sparkline } }`,
    ).join(' ');
    const res = await post(`{ ${wide} }`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.errors)).toMatch(/cost/i);
  });
});
