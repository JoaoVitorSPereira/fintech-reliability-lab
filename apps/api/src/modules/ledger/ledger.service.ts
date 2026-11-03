import { Injectable } from '@nestjs/common';
import type {
  LedgerTransactionKind,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { AccountBalanceChangedV1 } from '../events/domain-event';
import { OutboxService } from '../events/outbox.service';

type Tx = Prisma.TransactionClient;

export type Posting = { accountId: string; currency: string; amount: bigint };

export type IntegrityReport = {
  ok: boolean;
  /** Accounts whose cached balance differs from SUM(entries). */
  driftedAccounts: { accountId: string; balance: bigint; computed: bigint }[];
  /** Currencies whose entries don't sum to zero across the whole ledger. */
  unbalancedCurrencies: { currency: string; total: bigint }[];
};

// The only way money moves. Callers own the transaction (and the locks); this
// appends the entries. The database re-checks every rule here at COMMIT, so a
// bug in this file can't corrupt the ledger, only fail loudly.
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async post(
    tx: Tx,
    input: {
      /** Pass one when another row must reference the transaction first. */
      transactionId?: string;
      kind: LedgerTransactionKind;
      description: string;
      postings: Posting[];
      correlationId?: string | null;
    },
  ): Promise<{ transactionId: string }> {
    assertBalanced(input.postings);
    const transaction = await tx.ledgerTransaction.create({
      data: {
        id: input.transactionId,
        kind: input.kind,
        description: input.description,
      },
      select: { id: true },
    });
    const entries = await tx.ledgerEntry.createManyAndReturn({
      data: input.postings.map((posting) => ({
        transactionId: transaction.id,
        ...posting,
      })),
      select: { id: true, accountId: true, amount: true, createdAt: true },
    });

    // One event per customer account, in this same transaction. The version
    // bump is the event's sequence; the rows are already locked by the
    // balance trigger above, so this adds no new lock ordering.
    const touched = [...new Set(entries.map((entry) => entry.accountId))];
    const accounts = await tx.$queryRaw<
      {
        id: string;
        user_id: string;
        version: number;
        balance: bigint;
        currency: string;
      }[]
    >`
      UPDATE accounts SET version = version + 1
      WHERE id = ANY(${touched}::uuid[]) AND kind = 'CUSTOMER'
      RETURNING id, user_id, version, balance, currency`;
    await this.outbox.append(
      tx,
      accounts.map((account) => {
        const payload: AccountBalanceChangedV1 = {
          accountId: account.id,
          userId: account.user_id,
          currency: account.currency,
          balanceMinor: account.balance.toString(),
          ledgerTransactionId: transaction.id,
          kind: input.kind,
          description: input.description,
          entries: entries
            .filter((entry) => entry.accountId === account.id)
            .map((entry) => ({
              id: entry.id,
              amountMinor: entry.amount.toString(),
              createdAt: entry.createdAt.toISOString(),
            })),
        };
        return {
          aggregateType: 'account' as const,
          aggregateId: account.id,
          sequence: account.version,
          type: 'AccountBalanceChanged',
          version: 1,
          payload,
          correlationId: input.correlationId,
        };
      }),
    );
    return { transactionId: transaction.id };
  }

  // Reconciliation: the cached balances must equal the entries, and the
  // whole ledger must sum to zero per currency. Each query is one statement,
  // so it reads a consistent snapshot even while transfers are running.
  async verifyIntegrity(): Promise<IntegrityReport> {
    const drifted = await this.prisma.$queryRaw<
      { account_id: string; balance: bigint; computed: bigint }[]
    >`
      SELECT a.id AS account_id, a.balance, COALESCE(SUM(e.amount), 0)::bigint AS computed
      FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id
      HAVING a.balance <> COALESCE(SUM(e.amount), 0)`;
    const unbalanced = await this.prisma.$queryRaw<
      { currency: string; total: bigint }[]
    >`
      SELECT currency, SUM(amount)::bigint AS total FROM ledger_entries
      GROUP BY currency HAVING SUM(amount) <> 0`;

    return {
      ok: drifted.length === 0 && unbalanced.length === 0,
      driftedAccounts: drifted.map((row) => ({
        accountId: row.account_id,
        balance: row.balance,
        computed: row.computed,
      })),
      unbalancedCurrencies: unbalanced,
    };
  }
}

// Fail fast with a readable message. Not the real guard (the deferred
// trigger is), so a violation here is a programming error, not user input.
export function assertBalanced(postings: Posting[]): void {
  if (postings.length < 2) {
    throw new Error('A ledger transaction needs at least two postings');
  }
  const totals = new Map<string, bigint>();
  for (const { currency, amount } of postings) {
    if (amount === 0n) throw new Error('Postings must be non-zero');
    totals.set(currency, (totals.get(currency) ?? 0n) + amount);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) {
      throw new Error(`Postings in ${currency} sum to ${total}, not zero`);
    }
  }
}
