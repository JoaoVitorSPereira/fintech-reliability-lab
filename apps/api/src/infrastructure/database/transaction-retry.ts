import { Prisma } from '../../generated/prisma/client';

const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']); // deadlock, serialization failure
const MAX_ATTEMPTS = 3;

type DriverAdapterMeta = {
  driverAdapterError?: { cause?: { originalCode?: string; kind?: string } };
};

// Postgres aborts one side of a deadlock (40P01) or a serialization conflict
// (40001). The aborted transaction rolled back completely, so running it
// again is safe, PROVIDED the work is idempotent end to end (transfers are:
// see the idempotency key).
export function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const cause = (error.meta as DriverAdapterMeta | undefined)
    ?.driverAdapterError?.cause;
  return (
    RETRYABLE_SQLSTATES.has(cause?.originalCode ?? '') ||
    cause?.kind === 'TransactionWriteConflict'
  );
}

export async function withTransactionRetry<T>(
  work: () => Promise<T>,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) {
        throw error;
      }
      onRetry?.(attempt, error);
      // Jittered backoff so the two victims of a deadlock don't collide again.
      await new Promise((resolve) =>
        setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 20),
      );
    }
  }
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  return JSON.stringify(error.meta ?? {}).includes(constraint);
}
