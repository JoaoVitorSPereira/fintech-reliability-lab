import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { ConfigService } from '@nestjs/config';
import { maxDepthRule } from '@escape.tech/graphql-armor-max-depth';
import { join } from 'node:path';
import type { Env } from '../config/env';
import { formatGraphqlError } from './format-error';

export function graphqlConfig(
  config: ConfigService<Env, true>,
): Omit<ApolloDriverConfig, 'driver'> {
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  return {
    // Dev/test write the SDL to disk (committed, diffed in CI). Production
    // builds it in memory: the runtime filesystem may be read-only.
    autoSchemaFile: isProduction ? true : join(process.cwd(), 'schema.graphql'),
    sortSchema: true,
    introspection: !isProduction,
    graphiql: !isProduction,
    validationRules: [
      maxDepthRule({
        n: config.get('GRAPHQL_MAX_DEPTH', { infer: true }),
        ignoreIntrospection: true,
        exposeLimits: false,
      }),
    ],
    formatError: formatGraphqlError,
    // The auth guard reads the Authorization header from here.
    context: ({ req }: { req: unknown }) => ({ req }),
  };
}
