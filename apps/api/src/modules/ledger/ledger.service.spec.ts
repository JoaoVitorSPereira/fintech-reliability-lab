import { assertBalanced } from './ledger.service';

const brl = (accountId: string, amount: bigint) => ({
  accountId,
  currency: 'BRL',
  amount,
});

describe('assertBalanced', () => {
  it('accepts postings that sum to zero', () => {
    expect(() =>
      assertBalanced([brl('a', -500n), brl('b', 500n)]),
    ).not.toThrow();
  });

  it('accepts a split across more than two accounts', () => {
    expect(() =>
      assertBalanced([brl('a', -500n), brl('b', 300n), brl('c', 200n)]),
    ).not.toThrow();
  });

  it('rejects a single posting', () => {
    expect(() => assertBalanced([brl('a', 500n)])).toThrow(/two postings/);
  });

  it('rejects an unbalanced pair', () => {
    expect(() => assertBalanced([brl('a', -500n), brl('b', 499n)])).toThrow(
      /sum to -1/,
    );
  });

  it('rejects zero amounts', () => {
    expect(() => assertBalanced([brl('a', 0n), brl('b', 0n)])).toThrow(
      /non-zero/,
    );
  });

  it('balances per currency, not in total', () => {
    expect(() =>
      assertBalanced([
        brl('a', -500n),
        { accountId: 'b', currency: 'USD', amount: 500n },
      ]),
    ).toThrow(/BRL/);
  });
});
