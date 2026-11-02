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
