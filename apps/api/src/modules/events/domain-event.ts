// Versioned event contracts. A payload change that breaks consumers gets a
// new `version`; producers may emit both during a migration.

export type DomainEvent<T = unknown> = {
  id: string;
  type: string;
  version: number;
  aggregateType: AggregateType;
  aggregateId: string;
  /** Gapless per aggregate, starting at 1. */
  sequence: number;
  occurredAt: string;
  correlationId: string | null;
  payload: T;
};

export type AggregateType = 'account' | 'portfolio';

export const EVENT_CHANNEL: Record<AggregateType, string> = {
  account: 'events:account',
  portfolio: 'events:portfolio',
};

/** AccountBalanceChanged v1: one per customer account touched by a ledger transaction. */
export type AccountBalanceChangedV1 = {
  accountId: string;
  userId: string;
  currency: string;
  balanceMinor: string;
  ledgerTransactionId: string;
  kind: string;
  description: string;
  entries: { id: string; amountMinor: string; createdAt: string }[];
};

/** SimulatedOrderUpdated v1: any order state change (placed, filled, cancelled, rejected). */
export type SimulatedOrderUpdatedV1 = {
  orderId: string;
  portfolioId: string;
  userId: string;
  assetId: string;
  status: string;
  side: string;
  type: string;
  quantity: string;
};
