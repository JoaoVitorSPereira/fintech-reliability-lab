import { formatGraphqlError } from './format-error';

describe('formatGraphqlError', () => {
  it('masks internal errors and drops extra extensions', () => {
    const result = formatGraphqlError({
      message: 'Invalid `prisma.account.findMany()` invocation: ...',
      path: ['accounts'],
      extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['at ...'] },
    });

    expect(result).toEqual({
      message: 'Internal server error',
      path: ['accounts'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('masks errors with no code', () => {
    expect(formatGraphqlError({ message: 'boom' }).message).toBe(
      'Internal server error',
    );
  });

  it('keeps the message of known client errors', () => {
    const result = formatGraphqlError({
      message: 'Field "x" is not defined',
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED', debug: 'secret' },
    });

    expect(result.message).toBe('Field "x" is not defined');
    expect(result.extensions).toEqual({ code: 'GRAPHQL_VALIDATION_FAILED' });
  });
});
