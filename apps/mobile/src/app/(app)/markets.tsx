import { useQuery } from '@apollo/client/react';
import { useDeferredValue, useMemo, useState } from 'react';
import { FlatList, RefreshControl } from 'react-native';
import styled from 'styled-components/native';
import { AssetRow } from '@/components/market';
import { Caption, EmptyState, ErrorState, Field, Loading, SectionTitle, SegmentedControl } from '@/components/ui';
import type { AssetRowFieldsFragment } from '@/graphql/generated/graphql';
import { AssetsDocument } from '@/graphql/operations';
import { useLivePrices } from '@/hooks/use-live-prices';
import { errorMessage } from '@/lib/errors';
import { type MarketSort, type MarketTab, useUiStore } from '@/state/ui-store';

const PAGE = 30;
const Header = styled.View`
  padding: ${({ theme }) => theme.spacing.lg}px;
  gap: ${({ theme }) => theme.spacing.md}px;
`;
const Separator = styled.View`
  height: 1px;
  margin-left: 60px;
  background-color: ${({ theme }) => theme.colors.border};
`;

const SORTS = ['MARKET_CAP', 'PRICE', 'CHANGE_24H', 'VOLUME'] as const;
const SORT_LABELS: Record<MarketSort, string> = { MARKET_CAP: 'Mkt cap', PRICE: 'Price', CHANGE_24H: '24h %', VOLUME: 'Volume' };

function renderAsset({ item }: { item: AssetRowFieldsFragment }) {
  return <AssetRow asset={item} />;
}

export default function Markets() {
  // Selectors: this screen re-renders only when these two fields change.
  const tab = useUiStore((state) => state.marketTab);
  const sort = useUiStore((state) => state.marketSort);
  const setTab = useUiStore((state) => state.setMarketTab);
  const setSort = useUiStore((state) => state.setMarketSort);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());

  const { data, loading, error, refetch, fetchMore } = useQuery(AssetsDocument, {
    variables: { first: PAGE, category: tab, search: deferredSearch || null, sort },
  });
  const nodes = data?.assets.nodes ?? [];
  const ids = useMemo(() => nodes.map((asset) => asset.id).slice(0, 50), [nodes]);
  useLivePrices(ids, 3_000);

  const header = (
    <Header>
      <SectionTitle>Markets</SectionTitle>
      <SegmentedControl<MarketTab> options={['CRYPTO', 'STOCK', 'ETF']} value={tab} onChange={setTab} labels={{ CRYPTO: 'Crypto', STOCK: 'Stocks', ETF: 'ETFs' }} />
      <Field label="Search" placeholder="Name or symbol" value={search} onChangeText={setSearch} autoCorrect={false} autoCapitalize="characters" />
      <SegmentedControl options={SORTS} value={sort} onChange={setSort} labels={SORT_LABELS} />
      {tab !== 'CRYPTO' ? <Caption>Stock prices are delayed. Without a Twelve Data API key only AAPL is available.</Caption> : null}
    </Header>
  );

  if (!data && error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      data={nodes}
      keyExtractor={(asset) => asset.id}
      renderItem={renderAsset}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={header}
      ListEmptyComponent={loading ? <Loading /> : <EmptyState title="No assets match." />}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={() => void refetch()} />}
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (data?.assets.pageInfo.hasNextPage && !loading) {
          void fetchMore({ variables: { after: data.assets.pageInfo.endCursor } });
        }
      }}
      initialNumToRender={15}
      windowSize={7}
      removeClippedSubviews
    />
  );
}
