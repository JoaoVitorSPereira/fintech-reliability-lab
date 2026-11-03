import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseInput } from '../identity/inputs';
import { AppError } from '../../shared/errors/app-error';
import { isUuid } from '../../graphql/pagination';

/** Per-operation cap on simulated deposits. Keeps demo balances sane. */
export const MAX_SIMULATED_DEPOSIT_MINOR = 5_000_000n; // R$50,000.00

const id = z.string().refine(isUuid, 'Invalid account id');
// Client-generated, one per user intent (a UUID is ideal). Reused on retry.
const idempotencyKey = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{8,100}$/,
    'idempotencyKey must be 8-100 characters of [A-Za-z0-9_-]',
  );
// Parsed to minor units later, once the currency is known.
const amount = z.string().max(32);

export const transferSchema = z.object({
  fromAccountId: id,
  toAccountId: id,
  amount,
  idempotencyKey,
  description: z.string().trim().min(1).max(140).optional(),
});

export const depositSchema = z.object({
  accountId: id,
  amount,
  idempotencyKey,
});

export { parseInput };

// The canonical request, hashed. A retry must be byte-for-byte the same
// intent; the same key with a different amount is a client bug, not a retry.
export function requestHash(fields: Record<string, string>): string {
  const canonical = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('&');
  return createHash('sha256').update(canonical).digest('hex');
}

export function invalidAmount(): AppError {
  return new AppError(
    'BAD_USER_INPUT',
    'Amount must be a positive decimal with at most 2 decimal places, e.g. "150.25".',
  );
}
