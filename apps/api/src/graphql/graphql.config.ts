import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { ConfigService } from '@nestjs/config';
import { costLimitRule } from '@escape.tech/graphql-armor-cost-limit';
import { maxAliasesRule } from '@escape.tech/graphql-armor-max-aliases';
import { maxDepthRule } from '@escape.tech/graphql-armor-max-depth';
import type { GraphQLError, ValidationContext } from 'graphql';
import { join } from 'node:path';
import type { Env } from '../config/env';
import type { Metrics } from '../infrastructure/metrics/metrics';
import type { AuthService } from '../modules/identity/auth.service';
import { formatGraphqlError } from './format-error';
import { graphqlContext, subscriptionConfig } from './subscriptions';

// Every armor rule reports a normal validation error (HTTP 400) instead of
// throwing (which Apollo turns into a 500).
const asValidationError = {
  propagateOnRejection: false,
  onReject: [
    (context: ValidationContext | null, error: GraphQLError) =>
      context?.reportError(error),
  ],
};

export function graphqlConfig(
  config: ConfigService<Env, true>,
  auth: AuthService,
  metrics?: Metrics,
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
        ...asValidationError,
      }),
      // Depth alone doesn't stop a wide query (every list field, every
      // asset, every candle). Cost weighs objects more than scalars and
      // multiplies by depth; the app's heaviest screen costs well below this.
      costLimitRule({
        maxCost: config.get('GRAPHQL_MAX_COST', { infer: true }),
        flattenFragments: true,
        ignoreIntrospection: true,
        exposeLimits: !isProduction,
        ...asValidationError,
      }),
      // `a1: assets(...) a2: assets(...) ...` would multiply work per request.
      maxAliasesRule({
        n: 15,
        exposeLimits: !isProduction,
        ...asValidationError,
      }),
    ],
    formatError: formatGraphqlError,
    // The auth guard reads the Authorization header from here (HTTP), or
    // from connectionParams for WebSocket subscriptions.
    context: graphqlContext,
    subscriptions: subscriptionConfig(auth, metrics),
  };
}
