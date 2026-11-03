import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { memo } from 'react';
import styled from 'styled-components/native';
import type { AssetRowFieldsFragment, QuoteFieldsFragment } from '@/graphql/generated/graphql';
import { formatPercent, formatPrice } from '@/lib/money';
import { Sparkline } from './charts';
import { Body, Caption, Delta } from './ui';

const Badge = styled.Text<{ tone: 'live' | 'delayed' | 'stale' | 'cached' }>`
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  overflow: hidden;
  padding: 2px 6px;
  border-radius: 4px;
  color: ${({ tone, theme }) => (tone === 'stale' ? theme.colors.negative : tone === 'live' ? theme.colors.positive : theme.colors.warning)};
  background-color: ${({ theme }) => theme.colors.surfaceAlt};
`;

// The API's freshness label, shown verbatim. Stale prices are never styled as live.
export function QualityBadge({ quote }: { quote: Pick<QuoteFieldsFragment, 'dataQuality' | 'marketStatus'> }) {
  const tone = quote.dataQuality === 'LIVE' ? 'live' : quote.dataQuality === 'STALE' ? 'stale' : quote.dataQuality === 'CACHED' ? 'cached' : 'delayed';
  const label = quote.marketStatus === 'CLOSED' && quote.dataQuality !== 'STALE' ? 'CLOSED' : quote.dataQuality;
  return <Badge tone={tone} accessibilityLabel={`Price data: ${label.toLowerCase()}`}>{label}</Badge>;
}

const RowPress = styled.Pressable`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.md}px;
  padding: ${({ theme }) => theme.spacing.md}px 0;
`;

const Logo = styled(Image)`
  width: 32px;
  height: 32px;
  border-radius: 16px;
  background-color: ${({ theme }) => theme.colors.surfaceAlt};
`;

const Grow = styled.View`
  flex: 1;
  gap: 2px;
`;

const Right = styled.View`
  align-items: flex-end;
  gap: 2px;
`;

// memo + primitive-ish props: a price tick for BTC re-renders the BTC row,
// not the whole list (Apollo hands unchanged rows the same object).
export const AssetRow = memo(function AssetRow({ asset }: { asset: AssetRowFieldsFragment }) {
  const quote = asset.quote;
  return (
    <Link href={{ pathname: '/asset/[id]', params: { id: asset.id } }} asChild>
      <RowPress accessibilityRole="button" accessibilityLabel={`${asset.name}, ${quote ? formatPrice(quote.price) : 'no price'}`}>
        <Logo source={asset.logoUrl ? { uri: asset.logoUrl } : undefined} contentFit="cover" />
        <Grow>
          <Body bold numberOfLines={1}>{asset.symbol}</Body>
          <Caption numberOfLines={1}>
            {asset.marketCapRank ? `#${asset.marketCapRank} · ` : ''}{asset.name}
          </Caption>
        </Grow>
        <Sparkline values={asset.sparkline} />
        <Right>
          <Body bold>{quote ? formatPrice(quote.price) : '—'}</Body>
          {quote ? <Delta value={quote.change24h} size={12}>{formatPercent(quote.change24h)}</Delta> : <Caption>No price yet</Caption>}
        </Right>
      </RowPress>
    </Link>
  );
});
