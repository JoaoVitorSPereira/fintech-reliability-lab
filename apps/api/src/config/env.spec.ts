import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'dev-only-secret-0123456789abcdefghij',
};

describe('validateEnv', () => {
  it('applies defaults and coerces numbers', () => {
    const env = validateEnv({ ...valid, PORT: '4100' });
    expect(env.PORT).toBe(4100);
    expect(env.NODE_ENV).toBe('development');
    expect(env.GRAPHQL_MAX_DEPTH).toBe(8);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      validateEnv({ ...valid, DATABASE_URL: 'mysql://u:p@localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('refuses the dev placeholder JWT secret in production', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'production' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() =>
      validateEnv({
        ...valid,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'a-real-random-secret-0123456789abcdef',
      }),
    ).not.toThrow();
  });

  it('never echoes secret values in the error', () => {
    const secret = 'postgresql://u:SUPERSECRET@localhost:5432/db';
    try {
      validateEnv({ ...valid, DATABASE_URL: secret, PORT: 'not-a-number' });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect((error as Error).message).toMatch(/PORT/);
      expect((error as Error).message).not.toContain('SUPERSECRET');
    }
  });
});
