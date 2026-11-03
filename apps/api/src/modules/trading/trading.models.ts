import {
  Field,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import {
  OrderSide,
  OrderStatus,
  OrderType,
} from '../../generated/prisma/enums';
import { PageInfo } from '../../graphql/pagination';
import { Money } from '../accounts/accounts.models';
import { AssetModel } from '../market-data/market-data.models';

registerEnumType(OrderSide, { name: 'OrderSide' });
registerEnumType(OrderType, { name: 'OrderType' });
registerEnumType(OrderStatus, { name: 'OrderStatus' });

export enum PerformanceRange {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
  ALL = 'ALL',
}
registerEnumType(PerformanceRange, { name: 'PerformanceRange' });

export const SIMULATION_DISCLAIMER =
  'Simulated paper trade. Filled in full at the latest market-data price (Binance USDT prices treated as USD), with no spread, slippage, fees or order book. No real order was sent to any exchange.';

@ObjectType('Trade', {
  description: 'A SIMULATED execution, never a real exchange fill.',
})
export class TradeModel {
  @Field(() => ID)
  id: string;

  @Field()
  quantity: string;

  @Field({
    description:
      'Reference price from market data, not an exchange fill price.',
  })
  price: string;

  @Field(() => Money)
  notional: Money;

  @Field(() => Money, { nullable: true, description: 'Sells only.' })
  realizedPnl: Money | null;

  @Field()
  priceProvider: string;

  @Field()
  priceTimestamp: Date;

  @Field()
  executedAt: Date;
}

@ObjectType('SimulatedOrder')
export class SimulatedOrderModel {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  portfolioId: string;

  @Field(() => AssetModel)
  asset: AssetModel;

  @Field(() => OrderSide)
  side: OrderSide;

  @Field(() => OrderType)
  type: OrderType;

  @Field(() => OrderStatus)
  status: OrderStatus;

  @Field()
  quantity: string;

  @Field(() => String, { nullable: true })
  limitPrice: string | null;

  @Field(() => Money, { description: 'Cash held for a pending limit buy.' })
  reservedCash: Money;

  @Field(() => String, { nullable: true })
  rejectReason: string | null;

  @Field(() => TradeModel, { nullable: true })
  trade: TradeModel | null;

  @Field()
  createdAt: Date;

  @Field(() => Date, { nullable: true })
  filledAt: Date | null;

  @Field(() => Date, { nullable: true })
  cancelledAt: Date | null;

  @Field({
    description:
      'Always true. This platform does not route orders to any exchange.',
  })
  isSimulated: boolean;

  @Field()
  disclaimer: string;
}

@ObjectType()
export class SimulatedOrderResult {
  @Field(() => SimulatedOrderModel)
  order: SimulatedOrderModel;

  @Field({
    description: 'True when this idempotency key was already processed.',
  })
  replayed: boolean;
}

@ObjectType()
export class SimulatedOrderConnection {
  @Field(() => [SimulatedOrderModel])
  nodes: SimulatedOrderModel[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}

@ObjectType('Position')
export class PositionModel {
  @Field(() => AssetModel)
  asset: AssetModel;

  @Field()
  quantity: string;

  @Field({ description: 'Held for open limit sells.' })
  reservedQuantity: string;

  @Field(() => String, {
    nullable: true,
    description: 'Average acquisition price (average cost method).',
  })
  averagePrice: string | null;

  @Field(() => Money)
  costBasis: Money;

  @Field(() => Money, {
    nullable: true,
    description: 'Null when no price is available.',
  })
  marketValue: Money | null;

  @Field(() => Money, { nullable: true })
  unrealizedPnl: Money | null;

  @Field(() => String, { nullable: true })
  unrealizedPnlPct: string | null;

  @Field(() => Money)
  realizedPnl: Money;

  @Field(() => String, {
    nullable: true,
    description: 'Share of total portfolio value, percent.',
  })
  allocationPct: string | null;

  @Field()
  priceIsStale: boolean;
}

@ObjectType('ValuationPoint')
export class ValuationPointModel {
  @Field()
  at: Date;

  @Field(() => Money)
  totalValue: Money;

  @Field()
  isStale: boolean;
}

@ObjectType('Portfolio', {
  description:
    'A SIMULATED paper-trading portfolio. Cash is play money in USD.',
})
export class PortfolioModel {
  @Field(() => ID)
  id: string;

  @Field(() => ID, { description: 'Fund it with simulateDeposit.' })
  cashAccountId: string;

  @Field(() => Money, { description: 'Available to spend.' })
  cash: Money;

  @Field(() => Money, { description: 'Held for open limit buys.' })
  reservedCash: Money;

  @Field(() => [PositionModel])
  positions: PositionModel[];

  @Field(() => Money)
  marketValue: Money;

  @Field(() => Money, { description: 'Cash + reserved cash + market value.' })
  totalValue: Money;

  @Field(() => Money)
  unrealizedPnl: Money;

  @Field(() => Money)
  realizedPnl: Money;

  @Field(() => Money)
  totalPnl: Money;

  @Field(() => Money, {
    nullable: true,
    description:
      "Change of held positions over 24h, from each quote's 24h change. Null if any is unknown.",
  })
  dayChange: Money | null;

  @Field(() => String, {
    nullable: true,
    description: 'Cash share of total value, percent.',
  })
  cashAllocationPct: string | null;

  @Field({
    description: 'True if any holding is valued with a stale or missing price.',
  })
  valuationIsStale: boolean;

  @Field()
  isSimulated: boolean;

  // performance(range): field resolver
}

@ObjectType('WatchlistItem')
export class WatchlistItemModel {
  @Field(() => AssetModel)
  asset: AssetModel;

  @Field()
  addedAt: Date;
}

@InputType()
export class SimulatedOrderInput {
  @Field(() => ID)
  assetId: string;

  @Field(() => OrderSide)
  side: OrderSide;

  @Field(() => OrderType)
  type: OrderType;

  @Field({ description: 'Units, decimal string with up to 8 decimals.' })
  quantity: string;

  @Field(() => String, {
    nullable: true,
    description: 'Required for LIMIT orders.',
  })
  limitPrice?: string | null;

  @Field()
  idempotencyKey: string;
}
