import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

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
