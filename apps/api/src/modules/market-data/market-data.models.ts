import { DecimalScalar } from '../../graphql/scalars/decimal.scalar';
import {
  Field,
  Float,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { AssetCategory, ChartTimeframe } from '../../generated/prisma/enums';
import { PageInfo } from '../../graphql/pagination';

registerEnumType(AssetCategory, { name: 'AssetCategory' });
registerEnumType(ChartTimeframe, { name: 'ChartTimeframe' });

export enum DataQuality {
  LIVE = 'LIVE',
  DELAYED = 'DELAYED',
  CACHED = 'CACHED',
  STALE = 'STALE',
}
registerEnumType(DataQuality, {
  name: 'DataQuality',
  description:
    'LIVE: streamed from the exchange within the last 30s. DELAYED: provider data we cannot verify as real-time (all stocks). CACHED: a polled snapshot, still within its freshness window. STALE: older than its freshness window; never present as current.',
});

export enum MarketStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  ALWAYS_OPEN = 'ALWAYS_OPEN',
}
registerEnumType(MarketStatus, { name: 'MarketStatus' });

export enum AssetSort {
  MARKET_CAP = 'MARKET_CAP',
  PRICE = 'PRICE',
  CHANGE_24H = 'CHANGE_24H',
  VOLUME = 'VOLUME',
}
registerEnumType(AssetSort, { name: 'AssetSort' });

@ObjectType('MarketPrice', {
  description:
    'Decimal strings throughout. Check isStale before showing as current.',
})
export class MarketPriceModel {
  @Field(() => ID)
  assetId: string;

  @Field(() => DecimalScalar)
  price: string;

  @Field({ description: 'USD, or USDT for prices streamed from Binance.' })
  currency: string;

  @Field(() => DecimalScalar, {
    nullable: true,
    description: '24h change in percent.',
  })
  change24h: string | null;

  @Field(() => DecimalScalar, {
    nullable: true,
    description: '24h volume in the quote currency.',
  })
  volume24h: string | null;

  @Field(() => DecimalScalar, { nullable: true })
  marketCap: string | null;

  @Field()
  provider: string;

  @Field({ description: 'When the provider says this price was true.' })
  sourceTimestamp: Date;

  @Field({ description: 'When this server received it.' })
  fetchedAt: Date;

  @Field()
  isStale: boolean;

  @Field(() => DataQuality)
  dataQuality: DataQuality;

  @Field(() => MarketStatus)
  marketStatus: MarketStatus;
}

@ObjectType('Volatility', {
  description:
    'Realized volatility from hourly closes: standard deviation of hourly log returns, annualized by sqrt(8760) (24/7 markets). Descriptive statistics, not a forecast. Null when there is too little data.',
})
export class VolatilityModel {
  @Field(() => DecimalScalar, {
    nullable: true,
    description:
      'Last 24h, annualized, percent. Needs at least 12 hourly bars.',
  })
  annualized24hPct: string | null;

  @Field(() => DecimalScalar, {
    nullable: true,
    description:
      'Last 7 days, annualized, percent. Needs at least 48 hourly bars.',
  })
  annualized7dPct: string | null;

  @Field(() => DecimalScalar, {
    nullable: true,
    description: '(24h high - 24h low) / 24h low, percent.',
  })
  range24hPct: string | null;

  @Field(() => Int, {
    description: 'Hourly returns the 7-day figure is based on.',
  })
  sampleHours: number;
}

@ObjectType('Asset')
export class AssetModel {
  @Field(() => ID)
  id: string;

  @Field(() => AssetCategory)
  category: AssetCategory;

  @Field()
  symbol: string;

  @Field()
  name: string;

  @Field()
  quoteCurrency: string;

  @Field(() => String, { nullable: true })
  logoUrl: string | null;

  @Field(() => Int, { nullable: true })
  marketCapRank: number | null;

  // quote, sparkline, supportedTimeframes: field resolvers (batched).
}

@ObjectType()
export class AssetConnection {
  @Field(() => [AssetModel])
  nodes: AssetModel[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;

  @Field(() => Int)
  totalCount: number;
}

@ObjectType('Candle')
export class CandleModel {
  @Field({ description: 'Start of the interval, UTC.' })
  openTime: Date;

  @Field(() => DecimalScalar)
  open: string;

  @Field(() => DecimalScalar)
  high: string;

  @Field(() => DecimalScalar)
  low: string;

  @Field(() => DecimalScalar)
  close: string;

  @Field(() => DecimalScalar)
  volume: string;

  @Field({ description: 'False for the current, still-forming interval.' })
  isClosed: boolean;
}

@ObjectType('CandleSeries')
export class CandleSeriesModel {
  @Field(() => ID)
  assetId: string;

  @Field(() => ChartTimeframe)
  timeframe: ChartTimeframe;

  @Field(() => String, { nullable: true })
  provider: string | null;

  @Field(() => [CandleModel])
  candles: CandleModel[];

  @Field({
    description:
      'True when the provider was unreachable and stored candles are served.',
  })
  isStale: boolean;

  @Field({
    description:
      'False when intervals are missing. Missing intervals are never invented.',
  })
  isComplete: boolean;

  @Field(() => String, { nullable: true })
  note: string | null;
}

@ObjectType('ProviderStatus')
export class ProviderStatusModel {
  @Field()
  name: string;

  @Field()
  status: string;

  @Field(() => Date, { nullable: true })
  lastSuccessAt: Date | null;

  @Field(() => Date, { nullable: true })
  lastFailureAt: Date | null;

  @Field(() => String, { nullable: true })
  lastError: string | null;

  @Field(() => Int)
  consecutiveFailures: number;

  @Field(() => Float, { nullable: true })
  lastLatencyMs: number | null;

  @Field(() => Date, { nullable: true })
  rateLimitedUntil: Date | null;

  @Field(() => String, { nullable: true })
  note: string | null;
}

@ObjectType('MarketOverview')
export class MarketOverviewModel {
  @Field(() => DecimalScalar, {
    nullable: true,
    description: 'Total crypto market cap (CoinGecko), USD.',
  })
  totalMarketCapUsd: string | null;

  @Field(() => DecimalScalar, { nullable: true })
  marketCapChange24hPct: string | null;

  @Field(() => DecimalScalar, { nullable: true })
  btcDominancePct: string | null;

  @Field(() => Date, { nullable: true })
  asOf: Date | null;

  @Field(() => [AssetModel], { description: 'From fresh quotes only.' })
  topGainers: AssetModel[];

  @Field(() => [AssetModel])
  topLosers: AssetModel[];

  @Field(() => [AssetModel], { description: 'By 24h volume.' })
  mostTraded: AssetModel[];

  @Field(() => [AssetModel], {
    description: 'Highest 7-day realized volatility among crypto assets.',
  })
  mostVolatile: AssetModel[];

  @Field(() => [AssetModel], {
    description:
      'SPY and QQQ ETFs as stand-ins for the S&P 500 and Nasdaq-100. Not the indices themselves.',
  })
  indexProxies: AssetModel[];

  @Field(() => [ProviderStatusModel])
  providers: ProviderStatusModel[];
}
