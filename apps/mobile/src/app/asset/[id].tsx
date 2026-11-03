import { useMutation, useQuery } from '@apollo/client/react';
import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { PriceChart, VolumeChart } from '@/components/charts';
import { QualityBadge } from '@/components/market';
import { Banner, BannerText, Body, Button, Caption, Card, Delta, Display, ErrorState, Loading, Row, Screen, SectionTitle, SegmentedControl } from '@/components/ui';
import { AddToWatchlistDocument, AssetCandlesDocument, AssetDetailDocument, RemoveFromWatchlistDocument } from '@/graphql/operations';
import { useLivePrices } from '@/hooks/use-live-prices';
import { errorMessage } from '@/lib/errors';
import { formatCompact, formatPercent, formatPrice } from '@/lib/money';
import { TIMEFRAME_WINDOW_MS, type Timeframe, useUiStore } from '@/state/ui-store';

const TIMEFRAMES = ['M5', 'M15', 'H1', 'H4', 'D1', 'W1'] as const;
const TF_LABELS: Record<Timeframe, string> = { M5: '5m', M15: '15m', H1: '1h', H4: '4h', D1: '1D', W1: '1W' };

export default function AssetDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const timeframe = useUiStore((state) => state.timeframe);
  const chartMode = useUiStore((state) => state.chartMode);
  const setTimeframe = useUiStore((state) => state.setTimeframe);
  const setChartMode = useUiStore((state) => state.setChartMode);

  const detail = useQuery(AssetDetailDocument, { variables: { id } });
  const asset = detail.data?.asset;
  const supported = asset?.supportedTimeframes ?? [];
  const available = TIMEFRAMES.filter((tf) => supported.includes(tf));
  const activeTf = available.includes(timeframe) ? timeframe : (available[0] ?? 'H1');

  // Rounded to the minute so the variables (and the cache key) stay stable.
  const range = useMemo(() => {
    const to = Math.ceil(Date.now() / 60_000) * 60_000;
    return { from: new Date(to - TIMEFRAME_WINDOW_MS[activeTf]).toISOString(), to: new Date(to).toISOString() };
  }, [activeTf]);
  const candles = useQuery(AssetCandlesDocument, {
    variables: { id, timeframe: activeTf, ...range },
    skip: !asset || available.length === 0,
  });
  useLivePrices(asset ? [asset.id] : [], 1_000);

  const watching = detail.data?.watchlist.some((item) => item.asset.id === id) ?? false;
  const watchOptions = { refetchQueries: ['Dashboard'] };
  const [add] = useMutation(AddToWatchlistDocument, {
    // Watchlist is not money: optimistic UI is fine here (never for orders/transfers).
    optimisticResponse: { __typename: 'Mutation' as const, createWatchlistItem: { __typename: 'WatchlistItem' as const, addedAt: new Date().toISOString(), asset: { __typename: 'Asset' as const, id } } },
    // The optimistic item is written and refetched; Dashboard reconciles it.
    update: (cache) => cache.modify({ fields: { watchlist: (existing, { toReference }) => [...(existing as readonly object[]), { __typename: 'WatchlistItem', addedAt: new Date().toISOString(), asset: toReference({ __typename: 'Asset', id }) }] } }),
    ...watchOptions,
  });
  const [remove] = useMutation(RemoveFromWatchlistDocument, {
    optimisticResponse: { __typename: 'Mutation' as const, removeWatchlistItem: true },
    update: (cache) =>
      cache.modify({
        fields: {
          watchlist: (existing, { readField }) =>
            (existing as readonly object[]).filter((item) => readField('id', readField<{ __ref: string }>('asset', item as never)) !== id),
        },
      }),
    ...watchOptions,
  });

  if (!asset && detail.loading) return <Loading />;
  if (!asset) return <ErrorState message={detail.error ? errorMessage(detail.error) : 'Asset not found.'} onRetry={() => void detail.refetch()} />;
  const quote = asset.quote;
  const series = candles.data?.assetCandles;

  return (
    <Screen>
      <Stack.Screen options={{ title: asset.symbol }} />
      <Card>
        <Row>
          <Caption>{asset.name} · {asset.category}</Caption>
          {quote ? <QualityBadge quote={quote} /> : null}
        </Row>
        <Display>{quote ? `${formatPrice(quote.price)} ${quote.currency}` : 'No price yet'}</Display>
        {quote ? (
          <>
            <Delta value={quote.change24h}>{formatPercent(quote.change24h)} (24h)</Delta>
            <Caption>
              {quote.provider} · updated {new Date(quote.sourceTimestamp).toLocaleTimeString()}
              {quote.isStale ? ' · STALE, not current' : ''}
            </Caption>
          </>
        ) : null}
      </Card>

      <Card>
        {available.length > 0 ? (
          <>
            <SegmentedControl options={available} value={activeTf} onChange={setTimeframe} labels={TF_LABELS} />
            <SegmentedControl options={['line', 'candles'] as const} value={chartMode} onChange={setChartMode} labels={{ line: 'Line', candles: 'Candles' }} />
            {series && series.candles.length > 1 ? (
              <>
                <PriceChart candles={series.candles} mode={chartMode} />
                <VolumeChart candles={series.candles} />
                <Caption>
                  {series.provider} · {series.candles.length} bars · times in your timezone
                  {series.isComplete ? '' : ' · some intervals missing (not filled in)'}
                </Caption>
              </>
            ) : candles.loading ? <Loading /> : <Caption>No chart data for this range.</Caption>}
            {series?.isStale ? <Banner><BannerText>{series.note ?? 'Provider unavailable; showing stored data.'}</BannerText></Banner> : null}
            {candles.error ? <Caption>{errorMessage(candles.error)}</Caption> : null}
          </>
        ) : (
          <Caption>No provider offers charts for this asset.</Caption>
        )}
      </Card>

      <Card>
        <SectionTitle>Market data</SectionTitle>
        <Row><Caption>Market cap</Caption><Body>{formatCompact(quote?.marketCap)}</Body></Row>
        <Row><Caption>24h volume</Caption><Body>{formatCompact(quote?.volume24h)}</Body></Row>
        <Row><Caption>Rank</Caption><Body>{asset.marketCapRank ? `#${asset.marketCapRank}` : '—'}</Body></Row>
      </Card>

      <Row gap={12}>
        <Link href={{ pathname: '/trade/[assetId]', params: { assetId: asset.id, side: 'BUY' } }} asChild style={{ flex: 1 }}>
          <Button title="Buy" />
        </Link>
        <Link href={{ pathname: '/trade/[assetId]', params: { assetId: asset.id, side: 'SELL' } }} asChild style={{ flex: 1 }}>
          <Button title="Sell" variant="secondary" />
        </Link>
      </Row>
      <Button
        title={watching ? 'Remove from watchlist' : 'Add to watchlist'}
        variant="secondary"
        onPress={() => void (watching ? remove({ variables: { assetId: id } }) : add({ variables: { assetId: id } })).catch(() => undefined)}
      />
      <Caption>Buying and selling here is simulated paper trading. No real order is sent to any exchange.</Caption>
    </Screen>
  );
}
