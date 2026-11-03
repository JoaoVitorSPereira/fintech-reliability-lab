import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import type { Request } from 'express';
import type { Transfer } from '../../generated/prisma/client';
import { moneyOf } from '../accounts/accounts.service';
import { CurrentViewer } from '../identity/auth.guard';
import type { Viewer } from '../identity/auth.service';
import {
  CreateTransferInput,
  SimulateDepositInput,
  TransferResult,
} from './transfers.models';
import { TransfersService, type TransferOutcome } from './transfers.service';

function toResult({ transfer, replayed }: TransferOutcome): TransferResult {
  return { replayed, transfer: toTransferView(transfer) };
}

export function toTransferView(transfer: Transfer) {
  return {
    id: transfer.id,
    kind: transfer.kind,
    fromAccountId: transfer.fromAccountId,
    toAccountId: transfer.toAccountId,
    amount: moneyOf(transfer.amount, transfer.currency),
    description: transfer.description,
    createdAt: transfer.createdAt,
  };
}

function correlationId(req: Request): string | undefined {
  return typeof req.id === 'string' || typeof req.id === 'number'
    ? String(req.id)
    : undefined;
}

@Resolver()
export class TransfersResolver {
  constructor(private readonly transfers: TransfersService) {}

  @Mutation(() => TransferResult, {
    description:
      'Move money between accounts. Safe to retry with the same idempotencyKey.',
  })
  async createTransfer(
    @CurrentViewer() viewer: Viewer,
    @Args('input') input: CreateTransferInput,
    @Context('req') req: Request,
  ): Promise<TransferResult> {
    return toResult(
      await this.transfers.transfer(viewer, input, correlationId(req)),
    );
  }

  @Mutation(() => TransferResult, {
    description:
      'Paper money for the demo. No real funds move. Safe to retry with the same idempotencyKey.',
  })
  async simulateDeposit(
    @CurrentViewer() viewer: Viewer,
    @Args('input') input: SimulateDepositInput,
    @Context('req') req: Request,
  ): Promise<TransferResult> {
    return toResult(
      await this.transfers.simulateDeposit(viewer, input, correlationId(req)),
    );
  }
}
