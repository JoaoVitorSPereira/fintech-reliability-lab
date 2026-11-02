import { ApolloServerErrorCode } from '@apollo/server/errors';
import type { GraphQLFormattedError } from 'graphql';

// Whitelist what leaves the server. Unknown errors (bugs, Prisma/pg messages,
// stack traces) are masked; the original is logged by GraphqlLoggingPlugin.
export function formatGraphqlError(
  formatted: GraphQLFormattedError,
): GraphQLFormattedError {
  const code = formatted.extensions?.['code'];

  if (
    typeof code !== 'string' ||
    code === ApolloServerErrorCode.INTERNAL_SERVER_ERROR
  ) {
    return {
      message: 'Internal server error',
      path: formatted.path,
      extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
    };
  }

  return {
    message: formatted.message,
    locations: formatted.locations,
    path: formatted.path,
    extensions: { code },
  };
}
