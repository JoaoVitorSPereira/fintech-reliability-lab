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
// Tests never call real market-data providers. Config is read when
// AppModule is imported, so the URLs are fixed here and point at the port
// test/fake-provider.ts listens on (only suites that start it get answers).
export const FAKE_PROVIDER_PORT = 45_999;
const fake = `http://127.0.0.1:${FAKE_PROVIDER_PORT}`;
process.env['MARKET_INGESTION_ENABLED'] = 'false';
process.env['ORDER_MATCHING_ENABLED'] = 'false';
process.env['COINGECKO_BASE_URL'] = `${fake}/cg`;
process.env['BINANCE_REST_URL'] = `${fake}/bn`;
process.env['TWELVE_DATA_BASE_URL'] = `${fake}/td`;
