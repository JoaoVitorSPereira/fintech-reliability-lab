import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    GRAPHQL_MAX_DEPTH: z.coerce.number().int().min(1).max(20).default(8),
    // HS256 key: at least 256 bits. Generate with `openssl rand -base64 48`.
    JWT_ACCESS_SECRET: z.string().min(32),

    // Market data. Every provider below is free; keys are optional and must
    // never be committed. Base URLs are configurable so tests can point the
    // adapters at a local fake server.
    MARKET_INGESTION_ENABLED: z.stringbool().default(true),
    COINGECKO_BASE_URL: z.url().default('https://api.coingecko.com/api/v3'),
    COINGECKO_DEMO_API_KEY: z.string().optional(),
    BINANCE_REST_URL: z.url().default('https://data-api.binance.vision'),
    BINANCE_WS_URL: z.url().default('wss://data-stream.binance.vision'),
    TWELVE_DATA_BASE_URL: z.url().default('https://api.twelvedata.com'),
    // Without a key the public "demo" key is used, which only covers AAPL.
    TWELVE_DATA_API_KEY: z.string().optional(),
    STOCK_SYMBOLS: z
      .string()
      .default('AAPL,MSFT,NVDA,AMZN,GOOGL,SPY,QQQ')
      .transform((list) =>
        list
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    CRYPTO_LISTING_SIZE: z.coerce.number().int().min(5).max(100).default(25),
  })
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      !env.JWT_ACCESS_SECRET.startsWith('dev-'),
    {
      path: ['JWT_ACCESS_SECRET'],
      message:
        'The development placeholder secret cannot be used in production',
    },
  );

export type Env = z.infer<typeof envSchema>;

// Fail at boot, not on the first request. The message lists keys and rules,
// never the values (they may be secrets).
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
