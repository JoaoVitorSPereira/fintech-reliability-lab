// Tests must never touch the dev database. Real env vars win over .env, so
// pointing at dedicated test resources here is enough.
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] ??= 'silent';
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://fintech:fintech@localhost:5433/fintech_test';
process.env['REDIS_URL'] =
  process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379/1';
process.env['JWT_ACCESS_SECRET'] ??= 'test-only-secret-0123456789abcdefghijkl';
