import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { ConfigService } from '@nestjs/config';
import { maxDepthRule } from '@escape.tech/graphql-armor-max-depth';
import { join } from 'node:path';
import type { Env } from '../config/env';
import type { AuthService } from '../modules/identity/auth.service';
import { formatGraphqlError } from './format-error';
import { graphqlContext, subscriptionConfig } from './subscriptions';

export function graphqlConfig(
  config: ConfigService<Env, true>,
  auth: AuthService,
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
        // Fragments are reuse, not nesting: count the fields they expand to.
        flattenFragments: true,
        // Report as a validation error (400), not a thrown 500.
        propagateOnRejection: false,
        onReject: [(context, error) => context?.reportError(error)],
      }),
    ],
    formatError: formatGraphqlError,
    // The auth guard reads the Authorization header from here (HTTP), or
    // from connectionParams for WebSocket subscriptions.
    context: graphqlContext,
    subscriptions: subscriptionConfig(auth),
  };
}
