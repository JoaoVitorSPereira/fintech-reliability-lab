import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  type Asset,
  type Portfolio,
  Prisma,
  type SimulatedOrder,
} from '../../generated/prisma/client';
import {
  decodeCursor,
  isUuid,
  pageSize,
  toPage,
} from '../../graphql/pagination';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  isUniqueViolation,
  withTransactionRetry,
} from '../../infrastructure/database/transaction-retry';
import { AppError } from '../../shared/errors/app-error';
import { uuidv7 } from '../../shared/uuid';
import type { Viewer } from '../identity/auth.service';
import { parseInput } from '../identity/inputs';
import { LedgerService } from '../ledger/ledger.service';
import { MarketDataService } from '../market-data/market-data.service';
import { QuoteStore } from '../market-data/quote-store';
import { requestHash } from '../transfers/transfer-inputs';
import {
  MAX_NOTIONAL_MINOR,
  MIN_NOTIONAL_MINOR,
  applyBuy,
  applySell,
  buyCostMinor,
  executablePrice,
  limitIsMarketable,
  parsePrice,
  parseQuantity,
  sellProceedsMinor,
} from './order-math';
import { orderSchema } from './trading-inputs';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

export type OrderOutcome = { order: SimulatedOrder; replayed: boolean };
type Fill = { price: Decimal; provider: string; timestamp: Date };

// Called inside each order transaction after the state change, before COMMIT.
// Milestone 8 plugs the transactional outbox in here.
export type OrderChangeHook = (
  tx: Tx,
  order: SimulatedOrder,
  portfolio: Portfolio,
  version: number,
) => Promise<void>;

@Injectable()
export class OrdersService {
  private marketAccountId: string | undefined;
  private readonly hooks: OrderChangeHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly marketData: MarketDataService,
    private readonly quotes: QuoteStore,
    @InjectPinoLogger(OrdersService.name) private readonly logger: PinoLogger,
  ) {}

  onOrderChange(hook: OrderChangeHook): void {
    this.hooks.push(hook);
  }

  async place(
    viewer: Viewer,
    input: unknown,
    correlationId?: string,
  ): Promise<OrderOutcome> {
    const parsed = parseInput(orderSchema, input);
    const quantity = parseQuantity(parsed.quantity);
    if (!quantity)
      throw new AppError(
        'BAD_USER_INPUT',
        'Quantity must be a positive decimal with at most 8 decimal places.',
      );
    const limitPrice =
      parsed.limitPrice == null ? null : parsePrice(parsed.limitPrice);
    if (parsed.type === 'LIMIT' && !limitPrice) {
      throw new AppError(
        'BAD_USER_INPUT',
        'Limit price must be a positive decimal with at most 8 decimal places.',
      );
    }
    const portfolio = await this.requirePortfolio(viewer);
    const asset = await this.marketData.getAsset(parsed.assetId);
    const hash = requestHash({
      assetId: asset.id,
      side: parsed.side,
      type: parsed.type,
      quantity: quantity.toFixed(),
      limitPrice: limitPrice?.toFixed() ?? '',
    });

    const previous = await this.findByKey(viewer, parsed.idempotencyKey);
    if (previous) return this.replay(previous, hash);

    try {
      const order = await withTransactionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await this.lockPortfolio(tx, portfolio.id);
          const created = await tx.simulatedOrder.create({
            data: {
              portfolioId: portfolio.id,
              userId: viewer.userId,
              assetId: asset.id,
              side: parsed.side,
              type: parsed.type,
              quantity,
              limitPrice,
              status: 'PENDING',
              idempotencyKey: parsed.idempotencyKey,
              requestHash: hash,
              correlationId,
            },
          });
          return this.process(tx, portfolio, asset, created);
        }),
      );
      this.logger.info(
        { orderId: order.id, status: order.status, correlationId },
        'simulated order placed',
      );
      return { order, replayed: false };
    } catch (error) {
      if (
        isUniqueViolation(error, 'idempotency_key') ||
        error instanceof AppError
      ) {
        const winner = await this.findByKey(viewer, parsed.idempotencyKey);
        if (winner) return this.replay(winner, hash);
      }
      throw error;
    }
  }

  async cancel(viewer: Viewer, orderId: string): Promise<OrderOutcome> {
    const portfolio = await this.requirePortfolio(viewer);
    if (!isUuid(orderId)) throw new AppError('NOT_FOUND', 'Order not found.');
    return withTransactionRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockPortfolio(tx, portfolio.id);
        const order = await tx.simulatedOrder.findFirst({
          where: { id: orderId, portfolioId: portfolio.id },
        });
        if (!order) throw new AppError('NOT_FOUND', 'Order not found.');
        if (order.status === 'CANCELLED') return { order, replayed: true };
        if (order.status !== 'PENDING') {
          throw new AppError(
            'ORDER_NOT_PENDING',
            `Order is already ${order.status.toLowerCase()}.`,
          );
        }
        if (order.side === 'BUY' && order.reservedCashMinor > 0n) {
          await this.post(
            tx,
            'ORDER_RELEASE',
            `Release hold for cancelled order`,
            [
              {
                accountId: portfolio.reservedAccountId,
                amount: -order.reservedCashMinor,
              },
              {
                accountId: portfolio.cashAccountId,
                amount: order.reservedCashMinor,
              },
            ],
          );
        }
        if (order.side === 'SELL') {
          await tx.position.update({
            where: {
              portfolioId_assetId: {
                portfolioId: portfolio.id,
                assetId: order.assetId,
              },
            },
            data: { reservedQuantity: { decrement: order.quantity } },
          });
        }
        const cancelled = await tx.simulatedOrder.update({
          where: { id: order.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
        await this.changed(tx, cancelled, portfolio);
        return { order: cancelled, replayed: false };
      }),
    );
  }

  /** Limit-order matcher: fill pending orders whose limit the market has reached. */
  async matchPendingOrders(): Promise<string> {
    const pending = await this.prisma.simulatedOrder.findMany({
      where: { status: 'PENDING', type: 'LIMIT' },
      include: { asset: true },
      orderBy: { id: 'asc' },
      take: 500,
    });
    const quotes = await this.quotes.readMany([
      ...new Set(pending.map((order) => order.assetId)),
    ]);
    let filled = 0;
    for (const order of pending) {
      const price = executablePrice(
        order.asset.category,
        quotes.get(order.assetId) ?? null,
      );
      if (
        !price.ok ||
        !limitIsMarketable(order.side, order.limitPrice!, price.price)
      )
        continue;
      try {
        const result = await withTransactionRetry(() =>
          this.prisma.$transaction(async (tx) => {
            const portfolio = await tx.portfolio.findUniqueOrThrow({
              where: { id: order.portfolioId },
            });
            await this.lockPortfolio(tx, portfolio.id);
            // Re-read under the lock: it may have been cancelled or filled meanwhile.
            const current = await tx.simulatedOrder.findUniqueOrThrow({
              where: { id: order.id },
            });
            if (current.status !== 'PENDING') return current;
            return this.execute(tx, portfolio, order.asset, current, price);
          }),
        );
        if (result.status === 'FILLED') filled++;
      } catch (error) {
        this.logger.warn(
          { orderId: order.id, err: error },
          'limit order execution failed',
        );
      }
    }
    return `${filled}/${pending.length} pending limit orders filled`;
  }

  async list(viewer: Viewer, first: number, after?: string | null) {
    const portfolio = await this.requirePortfolio(viewer);
    const size = pageSize(first);
    const cursor = decodeCursor(after);
    const rows = await this.prisma.simulatedOrder.findMany({
      where: {
        portfolioId: portfolio.id,
        ...(cursor && { id: { lt: cursor } }),
      },
      orderBy: { id: 'desc' },
      take: size + 1,
      include: { asset: true, trade: true }, // joined here: no N+1 per order
    });
    return toPage(rows, size);
  }

  withDetails(orderId: string) {
    return this.prisma.simulatedOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { asset: true, trade: true },
    });
  }

  // ---------------------------------------------------------------------------

  private async process(
    tx: Tx,
    portfolio: Portfolio,
    asset: Asset,
    order: SimulatedOrder,
  ): Promise<SimulatedOrder> {
    const quote =
      (await this.quotes.readMany([asset.id])).get(asset.id) ?? null;
    const price = executablePrice(asset.category, quote);

    if (order.type === 'MARKET') {
      if (!price.ok) return this.reject(tx, portfolio, order, price.reason);
      return this.execute(tx, portfolio, asset, order, price);
    }

    // LIMIT: reserve what the order could need, then fill now if marketable.
    const limit = order.limitPrice!;
    if (order.side === 'BUY') {
      const hold = buyCostMinor(order.quantity, limit);
      const sizeProblem = notionalProblem(hold);
      if (sizeProblem) return this.reject(tx, portfolio, order, sizeProblem);
      if ((await this.balance(tx, portfolio.cashAccountId)) < hold) {
        return this.reject(
          tx,
          portfolio,
          order,
          'Insufficient cash for this order.',
        );
      }
      await this.post(tx, 'ORDER_HOLD', 'Hold for limit buy', [
        { accountId: portfolio.cashAccountId, amount: -hold },
        { accountId: portfolio.reservedAccountId, amount: hold },
      ]);
      order = await tx.simulatedOrder.update({
        where: { id: order.id },
        data: { reservedCashMinor: hold },
      });
    } else {
      const sizeProblem = notionalProblem(
        sellProceedsMinor(order.quantity, limit),
      );
      if (sizeProblem) return this.reject(tx, portfolio, order, sizeProblem);
      if (
        (await this.availableQuantity(tx, portfolio.id, asset.id)).lt(
          order.quantity,
        )
      ) {
        return this.reject(
          tx,
          portfolio,
          order,
          'Not enough units available to sell.',
        );
      }
      await tx.position.update({
        where: {
          portfolioId_assetId: { portfolioId: portfolio.id, assetId: asset.id },
        },
        data: { reservedQuantity: { increment: order.quantity } },
      });
    }

    if (price.ok && limitIsMarketable(order.side, limit, price.price)) {
      return this.execute(tx, portfolio, asset, order, price);
    }
    await this.changed(tx, order, portfolio);
    return order;
  }

  private async execute(
    tx: Tx,
    portfolio: Portfolio,
    asset: Asset,
    order: SimulatedOrder,
    fill: Fill,
  ): Promise<SimulatedOrder> {
    const marketAccountId = await this.marketAccount(tx);
    const position = await tx.position.findUnique({
      where: {
        portfolioId_assetId: { portfolioId: portfolio.id, assetId: asset.id },
      },
    });
    const state = position ?? {
      quantity: ZERO,
      costBasis: ZERO,
      realizedPnl: ZERO,
      reservedQuantity: ZERO,
    };
    const ledgerTransactionId = uuidv7();
    let notionalMinor: bigint;
    let realizedOnTrade: Decimal | null = null;

    if (order.side === 'BUY') {
      notionalMinor = buyCostMinor(order.quantity, fill.price);
      if (order.type === 'MARKET') {
        const sizeProblem = notionalProblem(notionalMinor);
        if (sizeProblem) return this.reject(tx, portfolio, order, sizeProblem);
        if ((await this.balance(tx, portfolio.cashAccountId)) < notionalMinor) {
          return this.reject(
            tx,
            portfolio,
            order,
            'Insufficient cash for this order.',
          );
        }
        await this.post(
          tx,
          'TRADE',
          `Simulated buy ${asset.symbol}`,
          [
            { accountId: portfolio.cashAccountId, amount: -notionalMinor },
            { accountId: marketAccountId, amount: notionalMinor },
          ],
          ledgerTransactionId,
        );
      } else {
        // Filled at or below the limit: pay from the hold, refund the rest.
        const refund = order.reservedCashMinor - notionalMinor;
        await this.post(
          tx,
          'TRADE',
          `Simulated buy ${asset.symbol}`,
          [
            {
              accountId: portfolio.reservedAccountId,
              amount: -order.reservedCashMinor,
            },
            { accountId: marketAccountId, amount: notionalMinor },
            ...(refund > 0n
              ? [{ accountId: portfolio.cashAccountId, amount: refund }]
              : []),
          ],
          ledgerTransactionId,
        );
      }
      const next = applyBuy(state, order.quantity, notionalMinor);
      await tx.position.upsert({
        where: {
          portfolioId_assetId: { portfolioId: portfolio.id, assetId: asset.id },
        },
        create: {
          portfolioId: portfolio.id,
          assetId: asset.id,
          quantity: next.quantity,
          costBasis: next.costBasis,
        },
        update: { quantity: next.quantity, costBasis: next.costBasis },
      });
    } else {
      notionalMinor = sellProceedsMinor(order.quantity, fill.price);
      if (order.type === 'MARKET') {
        const sizeProblem = notionalProblem(notionalMinor);
        if (sizeProblem) return this.reject(tx, portfolio, order, sizeProblem);
        const available = state.quantity.minus(state.reservedQuantity);
        if (available.lt(order.quantity))
          return this.reject(
            tx,
            portfolio,
            order,
            'Not enough units available to sell.',
          );
      }
      await this.post(
        tx,
        'TRADE',
        `Simulated sell ${asset.symbol}`,
        [
          { accountId: marketAccountId, amount: -notionalMinor },
          { accountId: portfolio.cashAccountId, amount: notionalMinor },
        ],
        ledgerTransactionId,
      );
      const next = applySell(state, order.quantity, notionalMinor);
      realizedOnTrade = next.realizedOnTrade;
      await tx.position.update({
        where: {
          portfolioId_assetId: { portfolioId: portfolio.id, assetId: asset.id },
        },
        data: {
          quantity: next.quantity,
          costBasis: next.costBasis,
          realizedPnl: next.realizedPnl,
          ...(order.type === 'LIMIT' && {
            reservedQuantity: { decrement: order.quantity },
          }),
        },
      });
    }

    await tx.trade.create({
      data: {
        orderId: order.id,
        portfolioId: portfolio.id,
        assetId: asset.id,
        side: order.side,
        quantity: order.quantity,
        price: fill.price,
        notionalMinor,
        realizedPnl: realizedOnTrade,
        priceProvider: fill.provider,
        priceTimestamp: fill.timestamp,
        ledgerTransactionId,
      },
    });
    const filled = await tx.simulatedOrder.update({
      where: { id: order.id },
      data: { status: 'FILLED', filledAt: new Date(), reservedCashMinor: 0n },
    });
    await this.changed(tx, filled, portfolio);
    return filled;
  }

  private async reject(
    tx: Tx,
    portfolio: Portfolio,
    order: SimulatedOrder,
    reason: string,
  ): Promise<SimulatedOrder> {
    const rejected = await tx.simulatedOrder.update({
      where: { id: order.id },
      data: { status: 'REJECTED', rejectReason: reason },
    });
    await this.changed(tx, rejected, portfolio);
    return rejected;
  }

  private async changed(
    tx: Tx,
    order: SimulatedOrder,
    portfolio: Portfolio,
  ): Promise<void> {
    const { version } = await tx.portfolio.update({
      where: { id: portfolio.id },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    for (const hook of this.hooks) await hook(tx, order, portfolio, version);
  }

  // Every order operation on a portfolio is serialized by this row lock.
  // ponytail: one lock per portfolio caps a single user's order throughput;
  // fine for retail paper trading.
  private async lockPortfolio(tx: Tx, portfolioId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM portfolios WHERE id = ${portfolioId}::uuid FOR UPDATE`;
  }

  private async post(
    tx: Tx,
    kind: 'TRADE' | 'ORDER_HOLD' | 'ORDER_RELEASE',
    description: string,
    postings: { accountId: string; amount: bigint }[],
    transactionId?: string,
  ): Promise<void> {
    await this.ledger.post(tx, {
      transactionId,
      kind,
      description,
      postings: postings.map((posting) => ({ ...posting, currency: 'USD' })),
    });
  }

  private async balance(tx: Tx, accountId: string): Promise<bigint> {
    return (
      await tx.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { balance: true },
      })
    ).balance;
  }

  private async availableQuantity(
    tx: Tx,
    portfolioId: string,
    assetId: string,
  ): Promise<Decimal> {
    const position = await tx.position.findUnique({
      where: { portfolioId_assetId: { portfolioId, assetId } },
    });
    return position ? position.quantity.minus(position.reservedQuantity) : ZERO;
  }

  private async marketAccount(tx: Tx): Promise<string> {
    this.marketAccountId ??= (
      await tx.account.findUniqueOrThrow({
        where: { systemCode: 'simulated-market:USD' },
        select: { id: true },
      })
    ).id;
    return this.marketAccountId;
  }

  private async requirePortfolio(viewer: Viewer): Promise<Portfolio> {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { userId: viewer.userId },
    });
    if (!portfolio)
      throw new AppError('NOT_FOUND', 'Create a portfolio first.');
    return portfolio;
  }

  private findByKey(viewer: Viewer, idempotencyKey: string) {
    return this.prisma.simulatedOrder.findUnique({
      where: {
        userId_idempotencyKey: { userId: viewer.userId, idempotencyKey },
      },
    });
  }

  private replay(previous: SimulatedOrder, hash: string): OrderOutcome {
    if (previous.requestHash !== hash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different order.',
      );
    }
    return { order: previous, replayed: true };
  }
}

function notionalProblem(minor: bigint): string | null {
  if (minor < MIN_NOTIONAL_MINOR)
    return 'Order value is below the 1.00 USD minimum.';
  if (minor > MAX_NOTIONAL_MINOR)
    return 'Order value is above the 1,000,000.00 USD maximum.';
  return null;
}
