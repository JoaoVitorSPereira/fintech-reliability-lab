import { Prisma } from '../../generated/prisma/client';
import {
  isRetryableTransactionError,
  withTransactionRetry,
} from './transaction-retry';

function pgError(originalCode: string) {
  return new Prisma.PrismaClientKnownRequestError('boom', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode } } },
  });
}

describe('transaction retry', () => {
  it('retries deadlocks and serialization failures only', () => {
    expect(isRetryableTransactionError(pgError('40P01'))).toBe(true);
    expect(isRetryableTransactionError(pgError('40001'))).toBe(true);
    expect(isRetryableTransactionError(pgError('23505'))).toBe(false);
    expect(isRetryableTransactionError(new Error('40P01'))).toBe(false);
  });

  it('gives up after 3 attempts', async () => {
    let calls = 0;
    await expect(
      withTransactionRetry(async () => {
        calls++;
        throw pgError('40P01');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(3);
  });

  it('returns the first successful attempt', async () => {
    let calls = 0;
    const result = await withTransactionRetry(async () => {
      if (++calls < 2) throw pgError('40001');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry business errors', async () => {
    let calls = 0;
    await expect(
      withTransactionRetry(async () => {
        calls++;
        throw new Error('INSUFFICIENT_FUNDS');
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
