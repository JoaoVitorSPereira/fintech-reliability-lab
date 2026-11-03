import {
  Args,
  Context,
  ID,
  Int,
  Mutation,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import type { Request } from 'express';
import type {
  Asset,
  Prisma,
  SimulatedOrder,
  Trade,
} from '../../generated/prisma/client';
import { CurrentViewer } from '../identity/auth.guard';
import type { Viewer } from '../identity/auth.service';
import { moneyOf } from '../accounts/accounts.service';
import {
  PerformanceRange,
  PortfolioModel,
  SIMULATION_DISCLAIMER,
  SimulatedOrderConnection,
  SimulatedOrderInput,
  SimulatedOrderModel,
  SimulatedOrderResult,
  ValuationPointModel,
  WatchlistItemModel,
} from './trading.models';
import { OrdersService } from './orders.service';
import { PortfolioService, type PortfolioValuation } from './portfolio.service';
import { WatchlistService } from './watchlist.service';

type Decimal = Prisma.Decimal;
type OrderWithDetails = SimulatedOrder & { asset: Asset; trade: Trade | null };

const usd = (value: Decimal) => ({ amount: value.toFixed(2), currency: 'USD' });
const pct = (part: Decimal, whole: Decimal) =>
  whole.gt(0) ? part.div(whole).times(100).toFixed(2) : null;

export function toOrderView(order: OrderWithDetails): SimulatedOrderModel {
  return {
    id: order.id,
    portfolioId: order.portfolioId,
    asset: order.asset,
    side: order.side,
    type: order.type,
    status: order.status,
    quantity: order.quantity.toFixed(),
    limitPrice: order.limitPrice?.toFixed() ?? null,
    reservedCash: moneyOf(order.reservedCashMinor, 'USD'),
    rejectReason: order.rejectReason,
    trade: order.trade && {
      id: order.trade.id,
      quantity: order.trade.quantity.toFixed(),
      price: order.trade.price.toFixed(),
      notional: moneyOf(order.trade.notionalMinor, 'USD'),
      realizedPnl: order.trade.realizedPnl
        ? usd(order.trade.realizedPnl)
        : null,
      priceProvider: order.trade.priceProvider,
      priceTimestamp: order.trade.priceTimestamp,
      executedAt: order.trade.executedAt,
    },
    createdAt: order.createdAt,
    filledAt: order.filledAt,
    cancelledAt: order.cancelledAt,
    isSimulated: true,
    disclaimer: SIMULATION_DISCLAIMER,
  };
}

function toPortfolioView(valuation: PortfolioValuation): PortfolioModel {
  const { totalValue } = valuation;
  return {
    id: valuation.portfolio.id,
    cashAccountId: valuation.portfolio.cashAccountId,
    cash: usd(valuation.cash),
    reservedCash: usd(valuation.reservedCash),
    marketValue: usd(valuation.marketValue),
    totalValue: usd(totalValue),
    unrealizedPnl: usd(valuation.unrealizedPnl),
    realizedPnl: usd(valuation.realizedPnl),
    totalPnl: usd(valuation.unrealizedPnl.plus(valuation.realizedPnl)),
    dayChange: valuation.dayChange ? usd(valuation.dayChange) : null,
    cashAllocationPct: pct(
      valuation.cash.plus(valuation.reservedCash),
      totalValue,
    ),
    valuationIsStale: valuation.isStale,
    netDeposits: usd(valuation.netDeposits),
    totalReturnPct: valuation.totalReturnPct?.toFixed(2) ?? null,
    isSimulated: true,
    positions: valuation.positions.map((position) => ({
      asset: position.asset,
      quantity: position.quantity.toFixed(),
      reservedQuantity: position.reservedQuantity.toFixed(),
      averagePrice: position.averagePrice?.toFixed() ?? null,
      costBasis: usd(position.costBasis),
      marketValue: position.marketValue ? usd(position.marketValue) : null,
      unrealizedPnl: position.unrealizedPnl
        ? usd(position.unrealizedPnl)
        : null,
      unrealizedPnlPct: position.unrealizedPnlPct?.toFixed(2) ?? null,
      realizedPnl: usd(position.realizedPnl),
      allocationPct: position.marketValue
        ? pct(position.marketValue, totalValue)
        : null,
      priceIsStale: position.priceIsStale,
    })),
  };
}

const RANGE_MS: Record<PerformanceRange, number> = {
  DAY: 86_400_000,
  WEEK: 7 * 86_400_000,
  MONTH: 31 * 86_400_000,
  ALL: Number.MAX_SAFE_INTEGER,
};

function correlationId(req: Request): string | undefined {
  return typeof req.id === 'string' || typeof req.id === 'number'
    ? String(req.id)
    : undefined;
}

@Resolver(() => PortfolioModel)
export class TradingResolver {
  constructor(
    private readonly portfolios: PortfolioService,
    private readonly orders: OrdersService,
    private readonly watchlists: WatchlistService,
  ) {}

  @Query(() => PortfolioModel, {
    nullable: true,
    description: 'Null until createPortfolio is called.',
  })
  async portfolio(
    @CurrentViewer() viewer: Viewer,
  ): Promise<PortfolioModel | null> {
    const portfolio = await this.portfolios.find(viewer);
    return portfolio && toPortfolioView(await this.portfolios.value(portfolio));
  }

  @Mutation(() => PortfolioModel, {
    description: 'Creates your paper-trading portfolio. Safe to call again.',
  })
  async createPortfolio(
    @CurrentViewer() viewer: Viewer,
  ): Promise<PortfolioModel> {
    return toPortfolioView(
      await this.portfolios.value(await this.portfolios.create(viewer)),
    );
  }

  @ResolveField(() => [ValuationPointModel])
  async performance(
    @CurrentViewer() viewer: Viewer,
    @Args('range', {
      type: () => PerformanceRange,
      defaultValue: PerformanceRange.WEEK,
    })
    range: PerformanceRange,
  ): Promise<ValuationPointModel[]> {
    const portfolio = await this.portfolios.require(viewer);
    const since = new Date(Math.max(0, Date.now() - RANGE_MS[range]));
    const points = await this.portfolios.performance(portfolio, since);
    return points.map((point) => ({
      at: point.at,
      totalValue: usd(point.totalValue),
      isStale: point.isStale,
    }));
  }

  @Query(() => SimulatedOrderConnection)
  async simulatedOrders(
    @CurrentViewer() viewer: Viewer,
    @Args('first', { type: () => Int }) first: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<SimulatedOrderConnection> {
    const page = await this.orders.list(viewer, first, after);
    return { pageInfo: page.pageInfo, nodes: page.nodes.map(toOrderView) };
  }

  @Mutation(() => SimulatedOrderResult, {
    description:
      'Paper trade. Business rejections (stale price, insufficient cash) return a REJECTED order, not an error. Safe to retry with the same idempotencyKey.',
  })
  async createSimulatedOrder(
    @CurrentViewer() viewer: Viewer,
    @Args('input') input: SimulatedOrderInput,
    @Context('req') req: Request,
  ): Promise<SimulatedOrderResult> {
    const { order, replayed } = await this.orders.place(
      viewer,
      input,
      correlationId(req),
    );
    return {
      replayed,
      order: toOrderView(await this.orders.withDetails(order.id)),
    };
  }

  @Mutation(() => SimulatedOrderResult)
  async cancelSimulatedOrder(
    @CurrentViewer() viewer: Viewer,
    @Args('orderId', { type: () => ID }) orderId: string,
  ): Promise<SimulatedOrderResult> {
    const { order, replayed } = await this.orders.cancel(viewer, orderId);
    return {
      replayed,
      order: toOrderView(await this.orders.withDetails(order.id)),
    };
  }

  @Query(() => [WatchlistItemModel])
  async watchlist(
    @CurrentViewer() viewer: Viewer,
  ): Promise<WatchlistItemModel[]> {
    return (await this.watchlists.list(viewer)).map((item) => ({
      asset: item.asset,
      addedAt: item.createdAt,
    }));
  }

  @Mutation(() => WatchlistItemModel)
  async createWatchlistItem(
    @CurrentViewer() viewer: Viewer,
    @Args('assetId', { type: () => ID }) assetId: string,
  ): Promise<WatchlistItemModel> {
    const item = await this.watchlists.add(viewer, assetId);
    return { asset: item.asset, addedAt: item.createdAt };
  }

  @Mutation(() => Boolean)
  removeWatchlistItem(
    @CurrentViewer() viewer: Viewer,
    @Args('assetId', { type: () => ID }) assetId: string,
  ): Promise<boolean> {
    return this.watchlists.remove(viewer, assetId);
  }
}
