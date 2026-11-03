import { Args, ID, Int, Query, Resolver, Subscription } from '@nestjs/graphql';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError } from '../../shared/errors/app-error';
import { isUuid } from '../../graphql/pagination';
import {
  AccountsService,
  moneyOf,
  toAccountView,
} from '../accounts/accounts.service';
import type {
  AccountBalanceChangedV1,
  DomainEvent,
  SimulatedOrderUpdatedV1,
} from '../events/domain-event';
import { EventBus } from '../events/event-bus';
import { CurrentViewer } from '../identity/auth.guard';
import type { Viewer } from '../identity/auth.service';
import type { PriceUpdateMessage } from '../market-data/ingestion/market-ingestion.service';
import { DataQuality } from '../market-data/market-data.models';
import { OrdersService } from '../trading/orders.service';
import { PortfolioService } from '../trading/portfolio.service';
import { toOrderView } from '../trading/trading.resolver';
import {
  AccountUpdate,
  DomainEventRecord,
  EventStreamInput,
  EventStreamType,
  MarketPriceUpdate,
  SimulatedOrderUpdate,
} from './realtime.models';

const MAX_PRICE_ASSETS = 50;

async function* filterMap<T, R>(
  source: AsyncGenerator<T>,
  map: (value: T) => Promise<R | null> | R | null,
): AsyncGenerator<R> {
  try {
    for await (const value of source) {
      const mapped = await map(value);
      if (mapped !== null) yield mapped;
    }
  } finally {
    await source.return(undefined); // unsubscribe from the bus when the client leaves
  }
}

// Authorization happens when the subscription starts (ownership checks in
// the domain services), and every event is filtered by aggregate id AND by
// owner, so a bug in one filter can't leak another user's data.
@Resolver()
export class RealtimeResolver {
  constructor(
    private readonly bus: EventBus,
    private readonly accounts: AccountsService,
    private readonly portfolios: PortfolioService,
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
  ) {}

  @Subscription(() => AccountUpdate, {
    resolve: (value: AccountUpdate) => value,
  })
  async accountUpdated(
    @CurrentViewer() viewer: Viewer,
    @Args('accountId', { type: () => ID }) accountId: string,
  ) {
    const account = await this.accounts.getOwned(viewer, accountId);
    return filterMap(
      this.bus.listen<DomainEvent<AccountBalanceChangedV1>>('events:account'),
      async (event) => {
        if (
          event.aggregateId !== account.id ||
          event.payload.userId !== viewer.userId
        )
          return null;
        const fresh = await this.prisma.account.findUnique({
          where: { id: account.id },
        });
        const entry = event.payload.entries[0];
        if (!fresh || !entry) return null;
        return {
          eventId: event.id,
          sequence: event.sequence,
          account: toAccountView(fresh),
          transaction: {
            id: entry.id,
            transactionId: event.payload.ledgerTransactionId,
            kind: event.payload.kind as AccountUpdate['transaction']['kind'],
            description: event.payload.description,
            amount: moneyOf(BigInt(entry.amountMinor), event.payload.currency),
            createdAt: new Date(entry.createdAt),
          },
        };
      },
    );
  }

  @Subscription(() => SimulatedOrderUpdate, {
    resolve: (value: SimulatedOrderUpdate) => value,
  })
  async simulatedOrderUpdated(
    @CurrentViewer() viewer: Viewer,
    @Args('portfolioId', { type: () => ID }) portfolioId: string,
  ) {
    const portfolio = await this.portfolios.find(viewer);
    if (!portfolio || portfolio.id !== portfolioId)
      throw new AppError('NOT_FOUND', 'Portfolio not found.');
    return filterMap(
      this.bus.listen<DomainEvent<SimulatedOrderUpdatedV1>>('events:portfolio'),
      async (event) => {
        if (
          event.aggregateId !== portfolio.id ||
          event.payload.userId !== viewer.userId
        )
          return null;
        const order = await this.orders.withDetails(event.payload.orderId);
        return {
          eventId: event.id,
          sequence: event.sequence,
          order: toOrderView(order),
        };
      },
    );
  }

  @Subscription(() => MarketPriceUpdate, {
    resolve: (value: MarketPriceUpdate) => value,
    description:
      'Only the assets you ask for (max 50). minIntervalMs throttles per asset: ~1000 for a detail screen, 5000+ for lists.',
  })
  marketPriceUpdated(
    @Args('assetIds', { type: () => [ID] }) assetIds: string[],
    @Args('minIntervalMs', { type: () => Int, defaultValue: 1000 })
    minIntervalMs: number,
  ) {
    if (
      assetIds.length === 0 ||
      assetIds.length > MAX_PRICE_ASSETS ||
      !assetIds.every(isUuid)
    ) {
      throw new AppError(
        'BAD_USER_INPUT',
        `Subscribe to 1-${MAX_PRICE_ASSETS} valid asset ids.`,
      );
    }
    const wanted = new Set(assetIds);
    const interval = Math.min(Math.max(minIntervalMs, 1000), 60_000);
    const lastSent = new Map<string, number>();
    return filterMap(
      this.bus.listen<PriceUpdateMessage>('md:prices'),
      (message) => {
        if (!wanted.has(message.assetId)) return null;
        const now = Date.now();
        if (now - (lastSent.get(message.assetId) ?? 0) < interval) return null;
        lastSent.set(message.assetId, now);
        return {
          assetId: message.assetId,
          price: message.price,
          currency: 'USDT',
          change24h: message.change24hPct,
          sourceTimestamp: new Date(message.sourceTimestamp),
          dataQuality: DataQuality.LIVE,
        };
      },
    );
  }

  @Query(() => [DomainEventRecord], {
    description:
      'Events after a sequence number, from the durable outbox. Call after reconnecting to fill gaps.',
  })
  async missedEvents(
    @CurrentViewer() viewer: Viewer,
    @Args('stream') stream: EventStreamInput,
    @Args('afterSequence', { type: () => Int }) afterSequence: number,
    @Args('first', { type: () => Int, defaultValue: 100 }) first: number,
  ): Promise<DomainEventRecord[]> {
    if (stream.type === EventStreamType.ACCOUNT) {
      await this.accounts.getOwned(viewer, stream.id);
    } else {
      const portfolio = await this.portfolios.find(viewer);
      if (!portfolio || portfolio.id !== stream.id)
        throw new AppError('NOT_FOUND', 'Portfolio not found.');
    }
    const events = await this.prisma.outboxEvent.findMany({
      where: {
        aggregateType:
          stream.type === EventStreamType.ACCOUNT ? 'account' : 'portfolio',
        aggregateId: stream.id,
        sequence: { gt: afterSequence },
      },
      orderBy: { sequence: 'asc' },
      take: Math.min(Math.max(first, 1), 500),
    });
    return events.map((event) => ({
      id: event.id,
      type: event.type,
      version: event.version,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      payloadJson: JSON.stringify(event.payload),
    }));
  }
}
