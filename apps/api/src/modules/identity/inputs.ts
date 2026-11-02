import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error';

// Normalize before validating: " Ana@Example.COM " and "ana@example.com" are
// the same account. The DB enforces lowercase with a CHECK constraint too.
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

// NIST SP 800-63B-4: length over composition rules. No "must contain a digit".
// The upper bound stops multi-megabyte "passwords" from tying up the hasher.
const newPassword = z
  .string()
  .min(15, 'Password must be at least 15 characters')
  .max(128, 'Password must be at most 128 characters');

const deviceName = z.string().trim().min(1).max(100).optional();

export const registerSchema = z.object({
  email,
  password: newPassword,
  deviceName,
});

// Login doesn't re-apply the policy: a policy change must not lock out
// existing users, and a precise error would leak which rule failed.
export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  deviceName,
});

export function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => issue.message)
      .join('; ');
    throw new AppError('BAD_USER_INPUT', message);
  }
  return result.data;
}
