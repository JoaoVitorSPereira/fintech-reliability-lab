import { ApolloServerErrorCode } from '@apollo/server/errors';
import { unwrapResolverError } from '@apollo/server/errors';
import type { GraphQLFormattedError } from 'graphql';
import { AppError } from '../shared/errors/app-error';

// Codes Apollo/graphql-js produce for malformed requests. Their messages
// describe the query, not server internals, so they're safe to return.
const REQUEST_ERROR_CODES = new Set<string>([
  ApolloServerErrorCode.GRAPHQL_PARSE_FAILED,
  ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
  ApolloServerErrorCode.BAD_USER_INPUT,
  ApolloServerErrorCode.BAD_REQUEST,
  ApolloServerErrorCode.OPERATION_RESOLUTION_FAILURE,
  ApolloServerErrorCode.PERSISTED_QUERY_NOT_FOUND,
  ApolloServerErrorCode.PERSISTED_QUERY_NOT_SUPPORTED,
]);

// Whitelist what leaves the server:
//  1. AppError: expected business failure, stable code + safe message.
//  2. Request errors from Apollo/graphql-js.
//  3. Everything else (bugs, Prisma/pg messages, stack traces) is masked;
//     GraphqlLoggingPlugin logs the original with the request id.
export function formatGraphqlError(
  formatted: GraphQLFormattedError,
  error?: unknown,
): GraphQLFormattedError {
  const original = error === undefined ? undefined : unwrapResolverError(error);

  if (original instanceof AppError) {
    return {
      message: original.message,
      path: formatted.path,
      extensions: { code: original.code },
    };
  }

  const code = formatted.extensions?.['code'];
  if (typeof code === 'string' && REQUEST_ERROR_CODES.has(code)) {
    return {
      message: formatted.message,
      locations: formatted.locations,
      path: formatted.path,
      extensions: { code },
    };
  }

  return {
    message: 'Internal server error',
    path: formatted.path,
    extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
  };
}
