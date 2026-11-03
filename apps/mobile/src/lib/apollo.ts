import { ApolloClient, ApolloLink, CombinedGraphQLErrors, HttpLink, InMemoryCache } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';
import { ErrorLink } from '@apollo/client/link/error';
import { RetryLink } from '@apollo/client/link/retry';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { OperationTypeNode } from 'graphql';
import { createClient } from 'graphql-ws';
import { from, switchMap } from 'rxjs';
import { config } from './config';
import { mergeConnection } from './pagination';
import { session } from './session-instance';

type AuthContext = { accessToken?: string | null; authRetried?: boolean };

// Retrying is only safe for operations that can't double-apply: queries, and
// mutations that carry an idempotency key (transfers, deposits, orders).
// Anything else is never retried automatically.
function isRetrySafe(operation: ApolloLink.Operation): boolean {
  if (operation.operationType === OperationTypeNode.QUERY) return true;
  const input = (operation.variables as { input?: { idempotencyKey?: unknown } }).input;
  return typeof input?.idempotencyKey === 'string';
}

const authLink = new SetContextLink(async (prevContext) => {
  const accessToken = await session.getAccessToken();
  return {
    accessToken,
    headers: { ...prevContext.headers, ...(accessToken && { authorization: `Bearer ${accessToken}` }) },
  };
});

// UNAUTHENTICATED (token expired or revoked mid-flight): refresh ONCE, shared
// by every request that failed at the same moment, then replay the operation
// one time. `authRetried` stops a refresh/retry loop.
const errorLink = new ErrorLink(({ error, operation, forward }) => {
  if (!CombinedGraphQLErrors.is(error)) return;
  const unauthenticated = error.errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED');
  const context = operation.getContext() as AuthContext;
  if (!unauthenticated || context.authRetried || !isRetrySafe(operation)) return;
  return from(session.refreshAfterRejection(context.accessToken ?? null)).pipe(
    switchMap((token) => {
      if (!token) return from([{ errors: error.errors }]);
      operation.setContext({
        authRetried: true,
        headers: { ...operation.getContext().headers, authorization: `Bearer ${token}` },
      });
      return forward(operation);
    }),
  );
});

// Network failures (offline, timeouts): exponential backoff, retry-safe ops only.
const retryLink = new RetryLink({
  delay: { initial: 400, max: 5_000, jitter: true },
  attempts: { max: 3, retryIf: (error, operation) => !CombinedGraphQLErrors.is(error) && isRetrySafe(operation) },
});

const httpLink = new HttpLink({ uri: config.httpUrl });

export const wsClient = createClient({
  url: config.wsUrl,
  lazy: true,
  // Called on every (re)connect, so a reconnect always sends a fresh token.
  connectionParams: async () => {
    const token = await session.getAccessToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
  retryAttempts: Infinity,
  shouldRetry: () => session.currentStatus !== 'signedOut',
  on: {
    closed: (event) => {
      // 4401: the server dropped us because the session/token is no longer
      // valid. Refresh; the automatic reconnect then uses the new token.
      if ((event as { code?: number }).code === 4401) void session.refreshAfterRejection(null);
    },
    connected: (_socket, _payload, wasRetry) => {
      // Events published while we were offline are gone from the socket.
      // Snapshot reconciliation: refetch what's on screen.
      if (wasRetry) void apolloClient.refetchQueries({ include: 'active' });
    },
  },
});

const link = ApolloLink.split(
  (operation) => operation.operationType === OperationTypeNode.SUBSCRIPTION,
  new GraphQLWsLink(wsClient),
  ApolloLink.from([retryLink, authLink, errorLink, httpLink]),
);

export const apolloClient = new ApolloClient({
  link,
  cache: new InMemoryCache({
    typePolicies: {
      // Price snapshots are identified by asset, so a subscription update
      // written as MarketPrice:{assetId} updates every screen showing it.
      MarketPrice: { keyFields: ['assetId'] },
      Query: {
        fields: {
          transactions: { keyArgs: ['accountId'], merge: mergeConnection },
          simulatedOrders: { keyArgs: false, merge: mergeConnection },
          assets: { keyArgs: ['category', 'search', 'sort'], merge: mergeConnection },
        },
      },
    },
  }),
  defaultOptions: {
    // Balances and positions: show the cache instantly, then confirm with the server.
    watchQuery: { fetchPolicy: 'cache-and-network' },
  },
});

session.subscribe((status) => {
  if (status === 'signedOut') {
    void wsClient.terminate();
    void apolloClient.clearStore();
  }
});
