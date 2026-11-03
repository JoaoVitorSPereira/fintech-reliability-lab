import {
  Args,
  ID,
  Int,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import type { Asset } from '../../generated/prisma/client';
import { AssetCategory, ChartTimeframe } from '../../generated/prisma/enums';
import { PageInfo, pageSize } from '../../graphql/pagination';
import { AppError } from '../../shared/errors/app-error';
import { MarketDataLoaders } from './market-data.loaders';
import {
  AssetConnection,
  AssetModel,
  AssetSort,
  CandleSeriesModel,
  DataQuality,
  MarketOverviewModel,
  MarketPriceModel,
  MarketStatus,
  ProviderStatusModel,
} from './market-data.models';
import { MarketDataService } from './market-data.service';
import { assessQuote } from './quote-store';

// Offset cursors are fine for a bounded, in-memory-sorted list (see
// MarketDataService.listAssets). Statements use keyset cursors instead.
function encodeOffset(offset: number) {
  return Buffer.from(`o:${offset}`).toString('base64url');
}
function decodeOffset(cursor?: string | null): number {
  if (!cursor) return 0;
  const match = /^o:(\d{1,6})$/.exec(
    Buffer.from(cursor, 'base64url').toString(),
  );
  if (!match) throw new AppError('BAD_USER_INPUT', 'Invalid cursor.');
  return Number(match[1]);
}

@Resolver(() => AssetModel)
export class MarketDataResolver {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly loaders: MarketDataLoaders,
  ) {}

  @Query(() => AssetConnection)
  async assets(
    @Args('first', { type: () => Int }) first: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
    @Args('category', { type: () => AssetCategory, nullable: true })
    category?: AssetCategory,
    @Args('search', { type: () => String, nullable: true }) search?: string,
    @Args('sort', { type: () => AssetSort, defaultValue: AssetSort.MARKET_CAP })
    sort?: AssetSort,
  ): Promise<AssetConnection> {
    const size = pageSize(first);
    if (search && search.length > 50)
      throw new AppError('BAD_USER_INPUT', 'Search is too long.');
    const offset = decodeOffset(after);
    const all = await this.marketData.listAssets({
      category,
      search,
      sort: sort ?? AssetSort.MARKET_CAP,
    });
    const nodes = all.slice(offset, offset + size);
    const pageInfo: PageInfo = {
      hasNextPage: offset + size < all.length,
      endCursor: nodes.length ? encodeOffset(offset + nodes.length) : null,
    };
    return { nodes, pageInfo, totalCount: all.length };
  }

  @Query(() => AssetModel)
  asset(@Args('id', { type: () => ID }) id: string): Promise<AssetModel> {
    return this.marketData.getAsset(id);
  }

  @Query(() => CandleSeriesModel)
  assetCandles(
    @Args('assetId', { type: () => ID }) assetId: string,
    @Args('timeframe', { type: () => ChartTimeframe })
    timeframe: ChartTimeframe,
    @Args('from') from: Date,
    @Args('to') to: Date,
  ): Promise<CandleSeriesModel> {
    return this.marketData.candles(assetId, timeframe, from, to);
  }

  @Query(() => MarketOverviewModel)
  async marketOverview(): Promise<MarketOverviewModel> {
    return {
      ...(await this.marketData.overview()),
      providers: this.marketData.providerStatus(),
    };
  }

  @Query(() => [ProviderStatusModel])
  marketProviders(): ProviderStatusModel[] {
    return this.marketData.providerStatus();
  }

  @ResolveField(() => MarketPriceModel, {
    nullable: true,
    description: 'Null until the first ingestion.',
  })
  async quote(@Parent() asset: Asset): Promise<MarketPriceModel | null> {
    const quote = await this.loaders.quotes.load(asset.id);
    if (!quote) return null;
    const assessment = assessQuote(quote, asset.category);
    return {
      assetId: asset.id,
      price: quote.price,
      currency: quote.currency,
      change24h: quote.change24hPct,
      volume24h: quote.volume24h,
      marketCap: quote.marketCap,
      provider: quote.provider,
      sourceTimestamp: new Date(quote.sourceTimestamp),
      fetchedAt: new Date(quote.fetchedAt),
      isStale: assessment.isStale,
      dataQuality: DataQuality[assessment.dataQuality],
      marketStatus: MarketStatus[assessment.marketStatus],
    };
  }

  @ResolveField(() => [String], {
    description:
      'Hourly closes for the last 24h, oldest first. Empty if not yet ingested.',
  })
  sparkline(@Parent() asset: Asset): Promise<string[]> {
    return this.loaders.sparklines.load(asset.id);
  }

  @ResolveField(() => [ChartTimeframe], {
    description: 'Timeframes a provider actually offers for this asset.',
  })
  supportedTimeframes(@Parent() asset: Asset): ChartTimeframe[] {
    const source = this.marketData.candleProviderFor(asset);
    return source ? [...source.provider.timeframes] : [];
  }
}
