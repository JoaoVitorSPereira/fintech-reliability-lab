import { useApolloClient, useSubscription } from '@apollo/client/react';
import { PriceUpdatesDocument } from '@/graphql/operations';

// Subscribes to only the assets on screen and writes each update into the
// normalized cache entry MarketPrice:{assetId}. Every component showing that
// asset re-renders; nothing else does. Lists pass a slower interval than the
// detail screen.
export function useLivePrices(assetIds: string[], minIntervalMs = 1000) {
  const client = useApolloClient();
  useSubscription(PriceUpdatesDocument, {
    variables: { assetIds, minIntervalMs },
    skip: assetIds.length === 0,
    onData: ({ data }) => {
      const update = data.data?.marketPriceUpdated;
      if (!update) return;
      client.cache.modify({
        id: client.cache.identify({ __typename: 'MarketPrice', assetId: update.assetId }),
        fields: {
          price: () => update.price,
          currency: () => update.currency,
          change24h: () => update.change24h,
          sourceTimestamp: () => update.sourceTimestamp,
          dataQuality: () => update.dataQuality,
          isStale: () => false,
          provider: () => 'binance-stream',
        },
      });
    },
  });
}
