import { useQuery } from '@apollo/client/react';
import { Link } from 'expo-router';
import { RefreshControl } from 'react-native';
import { AllocationBar } from '@/components/charts';
import { AssetRow } from '@/components/market';
import { Banner, BannerText, Body, Button, Caption, Card, Delta, Display, ErrorState, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { DashboardDocument } from '@/graphql/operations';
import { useLivePrices } from '@/hooks/use-live-prices';
import { errorMessage } from '@/lib/errors';
import { formatCompact, formatMoney, formatPercent } from '@/lib/money';

export default function Dashboard() {
  const { data, loading, error, refetch } = useQuery(DashboardDocument);
  const overview = data?.marketOverview;
  const watchlist = data?.watchlist ?? [];
  // Dashboard-level updates are slower than the detail screen's.
  useLivePrices(watchlist.map((item) => item.asset.id), 5_000);

  if (!data && loading) return <Loading />;
  if (!data && error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  const portfolio = data?.portfolio;

  return (
    <Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={() => void refetch()} />}>
      <Row>
        <SectionTitle>Home</SectionTitle>
        <Link href="/profile"><Caption>Profile</Caption></Link>
      </Row>

      <Card>
        <Caption>Paper portfolio value (simulated)</Caption>
        {portfolio ? (
          <>
            <Display>{formatMoney(portfolio.totalValue.amount, 'USD')}</Display>
            <Row>
              <Caption>Holdings, last 24h</Caption>
              {portfolio.dayChange ? <Delta value={portfolio.dayChange.amount}>{formatMoney(portfolio.dayChange.amount, 'USD', { signed: true })}</Delta> : <Caption>—</Caption>}
            </Row>
            <Row>
              <Caption>Total P&L</Caption>
              <Delta value={portfolio.totalPnl.amount}>
                {formatMoney(portfolio.totalPnl.amount, 'USD', { signed: true })}
                {portfolio.totalReturnPct ? ` (${formatPercent(portfolio.totalReturnPct)})` : ''}
              </Delta>
            </Row>
            <AllocationBar
              slices={[
                { label: 'Cash', pct: Number(portfolio.cashAllocationPct ?? 0) },
                ...portfolio.positions.filter((p) => p.allocationPct).map((p) => ({ label: p.asset.symbol, pct: Number(p.allocationPct) })),
              ]}
            />
            <Caption>
              Allocation: cash {portfolio.cashAllocationPct ?? '0'}%
              {portfolio.positions.filter((p) => p.allocationPct).map((p) => ` · ${p.asset.symbol} ${p.allocationPct}%`).join('')}
            </Caption>
            {portfolio.valuationIsStale ? <Banner><BannerText>Some holdings are valued with stale prices.</BannerText></Banner> : null}
          </>
        ) : (
          <>
            <Body secondary>Open a paper-trading portfolio to practise with live prices and play money.</Body>
            <Link href="/portfolio" asChild><Button title="Go to portfolio" variant="secondary" /></Link>
          </>
        )}
      </Card>

      {overview ? (
        <Card>
          <SectionTitle>Crypto market</SectionTitle>
          <Row>
            <Caption>Total market cap</Caption>
            <Body bold>${formatCompact(overview.totalMarketCapUsd)} <Delta value={overview.marketCapChange24hPct} size={12}>{formatPercent(overview.marketCapChange24hPct)}</Delta></Body>
          </Row>
          <Row>
            <Caption>BTC dominance</Caption>
            <Body>{overview.btcDominancePct ? `${overview.btcDominancePct.slice(0, 5)}%` : '—'}</Body>
          </Row>
          <Caption>Source: CoinGecko{overview.asOf ? ` · as of ${new Date(overview.asOf).toLocaleTimeString()}` : ''}</Caption>
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Watchlist</SectionTitle>
        {watchlist.length === 0 ? <Caption>Tap the star on any asset to follow it here.</Caption> : watchlist.map((item) => <AssetRow key={item.asset.id} asset={item.asset} />)}
      </Card>

      {overview?.topGainers.length ? (
        <Card>
          <SectionTitle>Top gainers (24h)</SectionTitle>
          {overview.topGainers.slice(0, 3).map((asset) => <AssetRow key={asset.id} asset={asset} />)}
          <SectionTitle>Top losers (24h)</SectionTitle>
          {overview.topLosers.slice(0, 3).map((asset) => <AssetRow key={asset.id} asset={asset} />)}
        </Card>
      ) : null}

      {overview?.mostTraded.length ? (
        <Card>
          <SectionTitle>Most traded</SectionTitle>
          {overview.mostTraded.slice(0, 3).map((asset) => <AssetRow key={asset.id} asset={asset} />)}
        </Card>
      ) : null}

      {overview?.mostVolatile.length ? (
        <Card>
          <SectionTitle>Most volatile (7d realized)</SectionTitle>
          <Caption>Annualized standard deviation of hourly returns. Describes the past week; not a forecast.</Caption>
          {overview.mostVolatile.slice(0, 3).map((asset) => (
            <Row key={asset.id}>
              <Body bold>{asset.symbol}</Body>
              <Body>{asset.volatility?.annualized7dPct ? `${asset.volatility.annualized7dPct}%` : '—'}</Body>
            </Row>
          ))}
        </Card>
      ) : null}

      {overview?.indexProxies.length ? (
        <Card>
          <SectionTitle>Index ETFs</SectionTitle>
          <Caption>SPY and QQQ track the S&P 500 and Nasdaq-100. They are funds, not the indices.</Caption>
          {overview.indexProxies.map((asset) => <AssetRow key={asset.id} asset={asset} />)}
        </Card>
      ) : null}

      {overview?.providers.some((p) => p.status !== 'UP' || p.note) ? (
        <Banner tone="info">
          {overview.providers.filter((p) => p.status !== 'UP' || p.note).map((p) => (
            <BannerText key={p.name}>{p.name}: {p.note ?? p.status.toLowerCase()}</BannerText>
          ))}
        </Banner>
      ) : null}
    </Screen>
  );
}
