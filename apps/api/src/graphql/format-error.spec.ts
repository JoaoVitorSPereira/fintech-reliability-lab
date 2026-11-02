import { GraphQLError } from 'graphql';
import { AppError } from '../shared/errors/app-error';
import { formatGraphqlError } from './format-error';

describe('formatGraphqlError', () => {
  it('passes AppError code and message through', () => {
    // Resolver errors always carry a path; Apollo only unwraps those.
    const thrown = new GraphQLError('wrapped', {
      path: ['register'],
      originalError: new AppError('EMAIL_TAKEN', 'Email is already in use'),
    });

    expect(
      formatGraphqlError(
        { message: 'wrapped', path: ['register'], extensions: {} },
        thrown,
      ),
    ).toEqual({
      message: 'Email is already in use',
      path: ['register'],
      extensions: { code: 'EMAIL_TAKEN' },
    });
  });

  it('masks unexpected errors and drops extra extensions', () => {
    const result = formatGraphqlError(
      {
        message: 'Invalid `prisma.account.findMany()` invocation: ...',
        path: ['accounts'],
        extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['at ...'] },
      },
      new GraphQLError('x', { originalError: new Error('pg: relation ...') }),
    );

    expect(result).toEqual({
      message: 'Internal server error',
      path: ['accounts'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('masks errors with an unknown or missing code', () => {
    expect(formatGraphqlError({ message: 'boom' }).message).toBe(
      'Internal server error',
    );
    expect(
      formatGraphqlError({
        message: 'Forbidden resource',
        extensions: { code: 'FORBIDDEN', originalError: { secret: 1 } },
      }).extensions,
    ).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('keeps the message of request validation errors', () => {
    const result = formatGraphqlError({
      message: 'Cannot query field "x" on type "Query".',
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED', debug: 'secret' },
    });

    expect(result.message).toBe('Cannot query field "x" on type "Query".');
    expect(result.extensions).toEqual({ code: 'GRAPHQL_VALIDATION_FAILED' });
  });
});
