import { Injectable } from '@nestjs/common';
import type {
  Account,
  AccountPurpose,
  Prisma,
} from '../../generated/prisma/client';
import {
  decodeCursor,
  isUuid,
  pageSize,
  toPage,
} from '../../graphql/pagination';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError } from '../../shared/errors/app-error';
import { type Currency, formatMinor, isCurrency } from '../../shared/money';
import type { Viewer } from '../identity/auth.service';

type Tx = Prisma.TransactionClient;

export function moneyOf(minor: bigint, currency: string) {
  if (!isCurrency(currency))
    throw new Error(`Unsupported currency ${currency}`);
  return { amount: formatMinor(minor, currency), currency };
}

export function toAccountView(account: Account) {
  return {
    id: account.id,
    currency: account.currency,
    purpose: account.purpose ?? 'CHECKING',
    balance: moneyOf(account.balance, account.currency),
    createdAt: account.createdAt,
  };
}

function accountNotFound() {
  return new AppError('NOT_FOUND', 'Account not found.');
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Runs inside the caller's transaction (registration, portfolio creation). */
  openCustomerAccount(
    tx: Tx,
    userId: string,
    currency: Currency,
    purpose: AccountPurpose = 'CHECKING',
  ) {
    return tx.account.create({
      data: { userId, kind: 'CUSTOMER', currency, purpose },
    });
  }

  listOwned(viewer: Viewer) {
    return this.prisma.account.findMany({
      where: { userId: viewer.userId },
      orderBy: { id: 'asc' },
    });
  }

  // Ownership lives in the WHERE clause: another user's account and a
  // non-existent one are indistinguishable to the caller.
  async getOwned(viewer: Viewer, accountId: string): Promise<Account> {
    const account = isUuid(accountId)
      ? await this.prisma.account.findFirst({
          where: { id: accountId, userId: viewer.userId },
        })
      : null;
    if (!account) throw accountNotFound();
    return account;
  }

  async statement(
    viewer: Viewer,
    accountId: string,
    first: number,
    after?: string | null,
  ) {
    const size = pageSize(first);
    const cursor = decodeCursor(after);
    const account = await this.getOwned(viewer, accountId);

    const rows = await this.prisma.ledgerEntry.findMany({
      where: { accountId: account.id, ...(cursor && { id: { lt: cursor } }) },
      orderBy: { id: 'desc' },
      take: size + 1,
      include: { transaction: { select: { kind: true, description: true } } },
    });

    const page = toPage(rows, size);
    return {
      pageInfo: page.pageInfo,
      nodes: page.nodes.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        kind: entry.transaction.kind,
        description: entry.transaction.description,
        amount: moneyOf(entry.amount, entry.currency),
        createdAt: entry.createdAt,
      })),
    };
  }
}
