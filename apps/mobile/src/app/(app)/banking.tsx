import { useApolloClient, useQuery, useSubscription } from '@apollo/client/react';
import { Link } from 'expo-router';
import { useRef, useState } from 'react';
import { FlatList, RefreshControl } from 'react-native';
import styled from 'styled-components/native';
import { Body, Button, Caption, Card, Delta, Display, EmptyState, ErrorState, Loading, Row, SectionTitle, SegmentedControl } from '@/components/ui';
import { AccountUpdatesDocument, AccountsDocument, TransactionFields, TransactionsDocument } from '@/graphql/operations';
import { errorMessage } from '@/lib/errors';
import { formatMoney } from '@/lib/money';

const Header = styled.View`
  padding: ${({ theme }) => theme.spacing.lg}px;
  gap: ${({ theme }) => theme.spacing.lg}px;
`;
const Line = styled.View`
  padding: ${({ theme }) => theme.spacing.md}px ${({ theme }) => theme.spacing.lg}px;
  gap: 2px;
`;

const PURPOSE_LABEL: Record<string, string> = { CHECKING: 'Checking', PORTFOLIO_CASH: 'Paper cash', PORTFOLIO_RESERVED: 'Paper reserved' };

export default function Banking() {
  const client = useApolloClient();
  const accounts = useQuery(AccountsDocument);
  const list = accounts.data?.accounts.filter((account) => account.purpose !== 'PORTFOLIO_RESERVED') ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const account = list.find((a) => a.id === selectedId) ?? list[0];

  const statement = useQuery(TransactionsDocument, { variables: { accountId: account?.id ?? '', first: 25 }, skip: !account });
  const lastSequence = useRef<Record<string, number>>({});

  // Live balance: Account:{id} updates through normalization. The new line is
  // prepended to the cached statement. A gap in `sequence` means we missed
  // events (e.g. while backgrounded): refetch instead of trusting the cache.
  useSubscription(AccountUpdatesDocument, {
    variables: { accountId: account?.id ?? '' },
    skip: !account,
    onData: ({ data }) => {
      const update = data.data?.accountUpdated;
      if (!update || !account) return;
      const previous = lastSequence.current[account.id];
      lastSequence.current[account.id] = update.sequence;
      if (previous !== undefined && update.sequence !== previous + 1) {
        void statement.refetch();
        return;
      }
      const added = client.cache.writeFragment({ fragment: TransactionFields, data: update.transaction });
      client.cache.modify({
        fields: {
          transactions(existing, { storeFieldName }) {
            const page = existing as { nodes: readonly { __ref: string }[] } | undefined;
            if (!page || !added || !storeFieldName.includes(account.id)) return existing;
            if (page.nodes.some((node) => node.__ref === added.__ref)) return existing;
            return { ...page, nodes: [added, ...page.nodes] };
          },
        },
      });
    },
  });

  if (!accounts.data && accounts.loading) return <Loading />;
  if (!accounts.data && accounts.error) return <ErrorState message={errorMessage(accounts.error)} onRetry={() => void accounts.refetch()} />;

  const header = (
    <Header>
      <SectionTitle>Banking</SectionTitle>
      {list.length > 1 ? (
        <SegmentedControl options={list.map((a) => a.id)} value={account?.id ?? ''} onChange={setSelectedId} labels={Object.fromEntries(list.map((a) => [a.id, PURPOSE_LABEL[a.purpose] ?? a.purpose]))} />
      ) : null}
      {account ? (
        <Card>
          <Caption>{PURPOSE_LABEL[account.purpose]} · {account.currency}</Caption>
          <Display>{formatMoney(account.balance.amount, account.currency)}</Display>
          <Row gap={12}>
            {account.purpose === 'CHECKING' ? (
              <Link href={{ pathname: '/transfer', params: { mode: 'transfer', accountId: account.id } }} asChild style={{ flex: 1 }}>
                <Button title="Transfer" />
              </Link>
            ) : null}
            <Link href={{ pathname: '/transfer', params: { mode: 'deposit', accountId: account.id } }} asChild style={{ flex: 1 }}>
              <Button title="Simulated deposit" variant="secondary" />
            </Link>
          </Row>
          <Caption>Account id (share it to receive transfers): {account.id}</Caption>
        </Card>
      ) : null}
      <SectionTitle>Statement</SectionTitle>
    </Header>
  );

  const nodes = statement.data?.transactions.nodes ?? [];
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      data={nodes}
      keyExtractor={(line) => line.id}
      ListHeaderComponent={header}
      ListEmptyComponent={statement.loading ? <Loading /> : <EmptyState title="No transactions yet." />}
      renderItem={({ item }) => (
        <Line>
          <Row>
            <Body numberOfLines={1}>{item.description}</Body>
            <Delta value={item.amount.amount}>{formatMoney(item.amount.amount, item.amount.currency, { signed: true })}</Delta>
          </Row>
          <Caption>{item.kind.replace('_', ' ').toLowerCase()} · {new Date(item.createdAt).toLocaleString()}</Caption>
        </Line>
      )}
      refreshControl={<RefreshControl refreshing={statement.loading && !!statement.data} onRefresh={() => { void accounts.refetch(); void statement.refetch(); }} />}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        const pageInfo = statement.data?.transactions.pageInfo;
        if (pageInfo?.hasNextPage && !statement.loading) void statement.fetchMore({ variables: { after: pageInfo.endCursor } });
      }}
      contentContainerStyle={{ paddingBottom: 48 }}
    />
  );
}
