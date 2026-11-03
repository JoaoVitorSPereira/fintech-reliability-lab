import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

export type GraphqlResponse<T> = {
  data?: T;
  errors?: { message: string; extensions: { code: string } }[];
};

export async function gql<T = Record<string, unknown>>(
  app: INestApplication<App>,
  query: string,
  variables: Record<string, unknown> = {},
  accessToken?: string,
): Promise<GraphqlResponse<T>> {
  const req = request(app.getHttpServer()).post('/graphql');
  if (accessToken) req.set('authorization', `Bearer ${accessToken}`);
  const res = await req.send({ query, variables });
  return res.body as GraphqlResponse<T>;
}

export function errorCode(response: GraphqlResponse<unknown>) {
  return response.errors?.[0]?.extensions.code;
}

export async function createTestApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  return app;
}

export type TestUser = {
  accessToken: string;
  userId: string;
  accountId: string;
};

/** Registers a fresh user (unique email) and returns their token + BRL account. */
export async function registerUser(
  app: INestApplication<App>,
): Promise<TestUser> {
  const res = await gql<{
    register: { accessToken: string; user: { id: string } };
  }>(
    app,
    `mutation R($input: RegisterInput!) { register(input: $input) { accessToken user { id } } }`,
    {
      input: {
        email: `user-${crypto.randomUUID()}@example.com`,
        password: 'a perfectly long passphrase',
      },
    },
  );
  const { accessToken, user } = res.data!.register;
  const accounts = await gql<{ accounts: { id: string }[] }>(
    app,
    '{ accounts { id } }',
    {},
    accessToken,
  );
  return {
    accessToken,
    userId: user.id,
    accountId: accounts.data!.accounts[0]!.id,
  };
}
