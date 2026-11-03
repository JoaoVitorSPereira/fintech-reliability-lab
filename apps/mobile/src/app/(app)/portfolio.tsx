import { useMutation, useQuery, useSubscription } from '@apollo/client/react';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl } from 'react-native';
import { AllocationBar, ValueChart } from '@/components/charts';
import { Banner, BannerText, Body, Button, Caption, Card, Delta, Display, ErrorState, Loading, Row, Screen, SectionTitle, SegmentedControl } from '@/components/ui';
import { CancelOrderDocument, CreatePortfolioDocument, OrderUpdatesDocument, OrdersDocument, PortfolioDocument } from '@/graphql/operations';
import { useLivePrices } from '@/hooks/use-live-prices';
import { errorMessage } from '@/lib/errors';
import { formatMoney, formatPercent, formatPrice } from '@/lib/money';

type Range = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';

export default function Portfolio() {
  const [range, setRange] = useState<Range>('WEEK');
  const { data, loading, error, refetch } = useQuery(PortfolioDocument, { variables: { range } });
  const orders = useQuery(OrdersDocument, { variables: { first: 20 } });
  const [createPortfolio, creating] = useMutation(CreatePortfolioDocument, { refetchQueries: ['Portfolio', 'Accounts'] });
  const [cancel] = useMutation(CancelOrderDocument, { refetchQueries: ['Portfolio'] });
  const portfolio = data?.portfolio;
  useLivePrices(portfolio?.positions.map((position) => position.asset.id) ?? [], 5_000);

  // Order events update SimulatedOrder:{id} in the cache by normalization;
  // cash and positions changed too, so refetch the authoritative portfolio.
  useSubscription(OrderUpdatesDocument, {
    variables: { portfolioId: portfolio?.id ?? '' },
    skip: !portfolio,
    onData: () => {
      void refetch();
      void orders.refetch();
    },
  });

  if (!data && loading) return <Loading />;
  if (!data && error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  if (!portfolio) {
    return (
      <Screen>
        <SectionTitle>Portfolio</SectionTitle>
        <Card>
          <Body>Paper trading lets you buy and sell real assets at live prices with play money. Nothing is sent to an exchange.</Body>
          <Button title="Create paper portfolio" loading={creating.loading} onPress={() => void createPortfolio().catch(() => undefined)} />
        </Card>
      </Screen>
    );
  }

  const slices = [
    { label: 'Cash', pct: Number(portfolio.cashAllocationPct ?? 0) },
    ...portfolio.positions.filter((p) => p.allocationPct).map((p) => ({ label: p.asset.symbol, pct: Number(p.allocationPct) })),
  ];

  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refetch()} />}>
      <SectionTitle>Portfolio (simulated)</SectionTitle>
      <Card>
        <Caption>Total value</Caption>
        <Display>{formatMoney(portfolio.totalValue.amount, 'USD')}</Display>
        <Row><Caption>Unrealized P&L</Caption><Delta value={portfolio.unrealizedPnl.amount}>{formatMoney(portfolio.unrealizedPnl.amount, 'USD', { signed: true })}</Delta></Row>
        <Row><Caption>Realized P&L</Caption><Delta value={portfolio.realizedPnl.amount}>{formatMoney(portfolio.realizedPnl.amount, 'USD', { signed: true })}</Delta></Row>
        <Row><Caption>Cash available</Caption><Body>{formatMoney(portfolio.cash.amount, 'USD')}</Body></Row>
        <Row><Caption>Reserved for orders</Caption><Body>{formatMoney(portfolio.reservedCash.amount, 'USD')}</Body></Row>
        {portfolio.valuationIsStale ? <Banner><BannerText>Some holdings are valued with stale or missing prices.</BannerText></Banner> : null}
        <Link href={{ pathname: '/transfer', params: { mode: 'deposit', accountId: portfolio.cashAccountId } }} asChild>
          <Button title="Add play money" variant="secondary" />
        </Link>
      </Card>

      <Card>
        <SegmentedControl options={['DAY', 'WEEK', 'MONTH', 'ALL'] as const} value={range} onChange={setRange} labels={{ DAY: '1D', WEEK: '1W', MONTH: '1M', ALL: 'All' }} />
        {portfolio.performance.length > 1 ? (
          <ValueChart points={portfolio.performance.map((point) => ({ at: point.at, value: point.totalValue.amount }))} />
        ) : (
          <Caption>Performance history appears after a few 15-minute snapshots.</Caption>
        )}
      </Card>

      <Card>
        <SectionTitle>Allocation</SectionTitle>
        <AllocationBar slices={slices} />
        {slices.map((slice) => <Row key={slice.label}><Caption>{slice.label}</Caption><Body>{slice.pct.toFixed(1)}%</Body></Row>)}
      </Card>

      <Card>
        <SectionTitle>Positions</SectionTitle>
        {portfolio.positions.length === 0 ? <Caption>No positions yet. Open an asset and tap Buy.</Caption> : null}
        {portfolio.positions.map((position) => (
          <Link key={position.asset.id} href={{ pathname: '/asset/[id]', params: { id: position.asset.id } }} asChild>
            <Pressable accessibilityRole="button" style={{ gap: 4 }}>
            <Row>
              <Body bold>{position.asset.symbol}</Body>
              <Body>{position.marketValue ? formatMoney(position.marketValue.amount, 'USD') : '—'}</Body>
            </Row>
            <Row>
              <Caption>{position.quantity} @ avg {position.averagePrice ? formatPrice(position.averagePrice) : '—'}{position.priceIsStale ? ' · stale price' : ''}</Caption>
              <Delta value={position.unrealizedPnlPct} size={12}>{formatPercent(position.unrealizedPnlPct)}</Delta>
            </Row>
            </Pressable>
          </Link>
        ))}
      </Card>

      <Card>
        <SectionTitle>Orders</SectionTitle>
        {orders.data?.simulatedOrders.nodes.length === 0 ? <Caption>No orders yet.</Caption> : null}
        {orders.data?.simulatedOrders.nodes.map((order) => (
          <Row key={order.id}>
            <Body>
              {order.side} {order.quantity} {order.asset.symbol}
              {order.limitPrice ? ` @ ${formatPrice(order.limitPrice)}` : ''}
            </Body>
            {order.status === 'PENDING' ? (
              <Button title="Cancel" variant="secondary" onPress={() => void cancel({ variables: { id: order.id } }).catch(() => undefined)} />
            ) : (
              <Caption>{order.status}{order.rejectReason ? `: ${order.rejectReason}` : ''}</Caption>
            )}
          </Row>
        ))}
      </Card>
    </Screen>
  );
}
