import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type {
  Prisma,
  Transfer,
  TransferKind,
} from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  isUniqueViolation,
  withTransactionRetry,
} from '../../infrastructure/database/transaction-retry';
import { AppError } from '../../shared/errors/app-error';
import {
  type Currency,
  isCurrency,
  parsePositiveAmount,
} from '../../shared/money';
import { uuidv7 } from '../../shared/uuid';
import type { Viewer } from '../identity/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  MAX_SIMULATED_DEPOSIT_MINOR,
  depositSchema,
  invalidAmount,
  parseInput,
  requestHash,
  transferSchema,
} from './transfer-inputs';

type Tx = Prisma.TransactionClient;

export type TransferOutcome = { transfer: Transfer; replayed: boolean };

type LockedAccount = {
  id: string;
  user_id: string | null;
  kind: 'CUSTOMER' | 'SYSTEM';
  purpose: 'CHECKING' | 'PORTFOLIO_CASH' | 'PORTFOLIO_RESERVED' | null;
  currency: string;
  balance: bigint;
};

type Command = {
  viewer: Viewer;
  kind: TransferKind;
  idempotencyKey: string;
  requestHash: string;
  fromAccountId: string;
  toAccountId: string;
  amountText: string;
  description: string;
  correlationId: string | undefined;
};

function notFound(what: 'Account' | 'Recipient account') {
  return new AppError('NOT_FOUND', `${what} not found.`);
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @InjectPinoLogger(TransfersService.name)
    private readonly logger: PinoLogger,
  ) {}

  async transfer(
    viewer: Viewer,
    input: unknown,
    correlationId?: string,
  ): Promise<TransferOutcome> {
    const parsed = parseInput(transferSchema, input);
    if (parsed.fromAccountId === parsed.toAccountId) {
      throw new AppError('BAD_USER_INPUT', 'Choose two different accounts.');
    }
    const description = parsed.description ?? 'Transfer';
    return this.execute({
      viewer,
      kind: 'TRANSFER',
      idempotencyKey: parsed.idempotencyKey,
      requestHash: requestHash({
        kind: 'TRANSFER',
        from: parsed.fromAccountId,
        to: parsed.toAccountId,
        amount: parsed.amount,
        description,
      }),
      fromAccountId: parsed.fromAccountId,
      toAccountId: parsed.toAccountId,
      amountText: parsed.amount,
      description,
      correlationId,
    });
  }

  // Simulated: money appears from the platform's external-funding account.
  // There is no payment rail behind it, and the API says so.
  async simulateDeposit(
    viewer: Viewer,
    input: unknown,
    correlationId?: string,
  ): Promise<TransferOutcome> {
    const parsed = parseInput(depositSchema, input);
    const target = await this.prisma.account.findFirst({
      where: { id: parsed.accountId, userId: viewer.userId },
      select: { currency: true },
    });
    if (!target) throw notFound('Account');
    const funding = await this.prisma.account.findUniqueOrThrow({
      where: { systemCode: `external-funding:${target.currency}` },
      select: { id: true },
    });

    return this.execute({
      viewer,
      kind: 'SIMULATED_DEPOSIT',
      idempotencyKey: parsed.idempotencyKey,
      requestHash: requestHash({
        kind: 'SIMULATED_DEPOSIT',
        to: parsed.accountId,
        amount: parsed.amount,
      }),
      fromAccountId: funding.id,
      toAccountId: parsed.accountId,
      amountText: parsed.amount,
      description: 'Simulated deposit',
      correlationId,
    });
  }

  private async execute(command: Command): Promise<TransferOutcome> {
    // Fast path for retries: no locks, no transaction.
    const previous = await this.findByKey(command);
    if (previous) return this.replay(previous, command);

    try {
      const transfer = await withTransactionRetry(
        () =>
          this.prisma.$transaction((tx) => this.apply(tx, command), {
            isolationLevel: 'ReadCommitted',
          }),
        (attempt, error) =>
          this.logger.warn(
            { attempt, err: error, correlationId: command.correlationId },
            'transfer transaction aborted by postgres, retrying',
          ),
      );
      this.logger.info(
        {
          transferId: transfer.id,
          kind: transfer.kind,
          correlationId: command.correlationId,
        },
        'transfer completed',
      );
      return { transfer, replayed: false };
    } catch (error) {
      // A concurrent request with the same key may have won the race. Ours
      // rolled back entirely, either on the unique index (P2002) or because
      // it waited for the account lock and then saw the winner's debit
      // (INSUFFICIENT_FUNDS). Either way, answer with the winner's result.
      if (
        isUniqueViolation(error, 'idempotency_key') ||
        error instanceof AppError
      ) {
        const winner = await this.findByKey(command);
        if (winner) return this.replay(winner, command);
      }
      if (error instanceof AppError) {
        this.logger.info(
          {
            code: error.code,
            kind: command.kind,
            correlationId: command.correlationId,
          },
          'transfer rejected',
        );
      }
      throw error;
    }
  }

  private async apply(tx: Tx, command: Command): Promise<Transfer> {
    const ledgerTransactionId = uuidv7();

    // 1. Lock both accounts in ONE statement, in id order. Every transfer
    //    locks in the same global order, so A->B and B->A can't deadlock.
    const locked = await tx.$queryRaw<LockedAccount[]>`
      SELECT id, user_id, kind::text AS kind, purpose::text AS purpose, currency, balance
      FROM accounts
      WHERE id IN (${command.fromAccountId}::uuid, ${command.toAccountId}::uuid)
      ORDER BY id
      FOR UPDATE`;
    const from = locked.find((account) => account.id === command.fromAccountId);
    const to = locked.find((account) => account.id === command.toAccountId);

    // 2. Validate under the lock: nothing can change these rows until COMMIT.
    const currency = this.validate(command, from, to);
    const amount = parsePositiveAmount(command.amountText, currency);
    if (amount === null) throw invalidAmount();
    if (
      command.kind === 'SIMULATED_DEPOSIT' &&
      amount > MAX_SIMULATED_DEPOSIT_MINOR
    ) {
      throw new AppError(
        'BAD_USER_INPUT',
        'Simulated deposits are capped at 50000.00 per operation.',
      );
    }
    if (from!.kind === 'CUSTOMER' && from!.balance < amount) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Insufficient funds.');
    }

    // 3. Record the transfer. This is also the idempotency claim: the unique
    //    index on (user_id, idempotency_key) fails a duplicate that got here.
    const transfer = await tx.transfer.create({
      data: {
        userId: command.viewer.userId,
        kind: command.kind,
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
        fromAccountId: command.fromAccountId,
        toAccountId: command.toAccountId,
        amount,
        currency,
        description: command.description,
        ledgerTransactionId,
        correlationId: command.correlationId,
      },
    });

    // 4. Move the money. The CHECK constraint and deferred balance trigger
    //    re-verify all of this at COMMIT.
    await this.ledger.post(tx, {
      transactionId: ledgerTransactionId,
      kind: command.kind === 'TRANSFER' ? 'TRANSFER' : 'DEPOSIT',
      description: command.description,
      postings: [
        { accountId: command.fromAccountId, currency, amount: -amount },
        { accountId: command.toAccountId, currency, amount },
      ],
    });
    return transfer;
  }

  private validate(
    command: Command,
    from: LockedAccount | undefined,
    to: LockedAccount | undefined,
  ): Currency {
    const isDeposit = command.kind === 'SIMULATED_DEPOSIT';
    // Ownership check at the domain boundary, not in the resolver.
    if (!from || (!isDeposit && from.user_id !== command.viewer.userId)) {
      throw notFound('Account');
    }
    // Transfers move banking money only. Paper-trading cash enters through
    // simulated deposits and is otherwise moved only by the order engine
    // (under the portfolio lock), so its balance checks can't be raced.
    const isTransferable = (account: LockedAccount) =>
      account.kind === 'CUSTOMER' && account.purpose === 'CHECKING';
    if (!isDeposit && !isTransferable(from)) throw notFound('Account');
    if (
      !to ||
      (isDeposit
        ? to.kind !== 'CUSTOMER' || to.purpose === 'PORTFOLIO_RESERVED'
        : !isTransferable(to))
    ) {
      throw notFound('Recipient account');
    }
    if (isDeposit && to.user_id !== command.viewer.userId)
      throw notFound('Account');
    if (from.currency !== to.currency || !isCurrency(from.currency)) {
      throw new AppError(
        'BAD_USER_INPUT',
        'Both accounts must use the same currency.',
      );
    }
    return from.currency;
  }

  private findByKey(command: Command) {
    return this.prisma.transfer.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: command.viewer.userId,
          idempotencyKey: command.idempotencyKey,
        },
      },
    });
  }

  private replay(previous: Transfer, command: Command): TransferOutcome {
    if (previous.requestHash !== command.requestHash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different request.',
      );
    }
    return { transfer: previous, replayed: true };
  }
}
