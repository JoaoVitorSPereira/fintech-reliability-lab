import { graphql } from './generated';

// Every operation the app sends, in one place. Codegen turns each into a
// TypedDocumentNode, so useQuery/useMutation are fully typed with no
// hand-written response types.

export const QuoteFields = graphql(`
  fragment QuoteFields on MarketPrice {
    assetId price currency change24h volume24h marketCap provider sourceTimestamp isStale dataQuality marketStatus
  }
`);

export const AssetRowFields = graphql(`
  fragment AssetRowFields on Asset {
    id symbol name category logoUrl marketCapRank quoteCurrency sparkline
    quote { ...QuoteFields }
  }
`);

export const SignInDocument = graphql(`
  mutation SignIn($input: LoginInput!) {
    login(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }
  }
`);

export const SignUpDocument = graphql(`
  mutation SignUp($input: RegisterInput!) {
    register(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }
  }
`);

export const LogoutDocument = graphql(`mutation Logout { logout }`);

export const MeDocument = graphql(`
  query Me {
    me { id email createdAt }
    sessions { id deviceName createdAt lastRefreshedAt current }
  }
`);

export const RevokeSessionDocument = graphql(`mutation RevokeSession($id: ID!) { revokeSession(id: $id) }`);

export const DashboardDocument = graphql(`
  query Dashboard {
    portfolio {
      id totalValue { amount currency } dayChange { amount currency } totalPnl { amount currency } valuationIsStale
      totalReturnPct cashAllocationPct positions { allocationPct asset { id symbol } }
    }
    marketOverview {
      totalMarketCapUsd marketCapChange24hPct btcDominancePct asOf
      topGainers { ...AssetRowFields }
      topLosers { ...AssetRowFields }
      mostTraded { ...AssetRowFields }
      mostVolatile { ...AssetRowFields volatility { annualized7dPct } }
      indexProxies { ...AssetRowFields }
      providers { name status note }
    }
    watchlist { addedAt asset { ...AssetRowFields } }
  }
`);

export const AssetsDocument = graphql(`
  query Assets($first: Int!, $after: String, $category: AssetCategory, $search: String, $sort: AssetSort) {
    assets(first: $first, after: $after, category: $category, search: $search, sort: $sort) {
      totalCount
      nodes { ...AssetRowFields }
      pageInfo { endCursor hasNextPage }
    }
  }
`);

export const AssetDetailDocument = graphql(`
  query AssetDetail($id: ID!) {
    asset(id: $id) {
      ...AssetRowFields supportedTimeframes
      volatility { annualized24hPct annualized7dPct range24hPct sampleHours }
    }
    watchlist { asset { id } }
  }
`);

export const AssetCandlesDocument = graphql(`
  query AssetCandles($id: ID!, $timeframe: ChartTimeframe!, $from: DateTime!, $to: DateTime!) {
    assetCandles(assetId: $id, timeframe: $timeframe, from: $from, to: $to) {
      provider isStale isComplete note
      candles { openTime open high low close volume isClosed }
    }
  }
`);

export const AddToWatchlistDocument = graphql(`
  mutation AddToWatchlist($assetId: ID!) { createWatchlistItem(assetId: $assetId) { addedAt asset { id } } }
`);

export const RemoveFromWatchlistDocument = graphql(`
  mutation RemoveFromWatchlist($assetId: ID!) { removeWatchlistItem(assetId: $assetId) }
`);

export const PriceUpdatesDocument = graphql(`
  subscription PriceUpdates($assetIds: [ID!]!, $minIntervalMs: Int) {
    marketPriceUpdated(assetIds: $assetIds, minIntervalMs: $minIntervalMs) {
      assetId price currency change24h sourceTimestamp dataQuality
    }
  }
`);

export const PortfolioDocument = graphql(`
  query Portfolio($range: PerformanceRange) {
    portfolio {
      id cashAccountId isSimulated valuationIsStale
      cash { amount currency } reservedCash { amount currency } marketValue { amount currency }
      totalValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }
      totalPnl { amount currency } dayChange { amount currency } cashAllocationPct
      totalReturnPct netDeposits { amount currency }
      positions {
        quantity reservedQuantity averagePrice allocationPct unrealizedPnlPct priceIsStale
        costBasis { amount currency } marketValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }
        asset { ...AssetRowFields }
      }
      performance(range: $range) { at totalValue { amount currency } isStale }
    }
  }
`);

export const CreatePortfolioDocument = graphql(`mutation CreatePortfolio { createPortfolio { id cashAccountId } }`);

export const OrderFields = graphql(`
  fragment OrderFields on SimulatedOrder {
    id portfolioId side type status quantity limitPrice rejectReason createdAt filledAt cancelledAt isSimulated disclaimer
    reservedCash { amount currency }
    asset { id symbol name }
    trade { id price quantity priceProvider priceTimestamp notional { amount currency } realizedPnl { amount currency } }
  }
`);

export const OrdersDocument = graphql(`
  query Orders($first: Int!, $after: String) {
    simulatedOrders(first: $first, after: $after) { nodes { ...OrderFields } pageInfo { endCursor hasNextPage } }
  }
`);

export const PlaceOrderDocument = graphql(`
  mutation PlaceOrder($input: SimulatedOrderInput!) {
    createSimulatedOrder(input: $input) { replayed order { ...OrderFields } }
  }
`);

export const CancelOrderDocument = graphql(`
  mutation CancelOrder($id: ID!) { cancelSimulatedOrder(orderId: $id) { replayed order { ...OrderFields } } }
`);

export const OrderUpdatesDocument = graphql(`
  subscription OrderUpdates($portfolioId: ID!) {
    simulatedOrderUpdated(portfolioId: $portfolioId) { eventId sequence order { ...OrderFields } }
  }
`);

export const AccountsDocument = graphql(`
  query Accounts { accounts { id currency purpose createdAt balance { amount currency } } }
`);

export const TransactionFields = graphql(`
  fragment TransactionFields on Transaction { id transactionId kind description createdAt amount { amount currency } }
`);

export const TransactionsDocument = graphql(`
  query Transactions($accountId: ID!, $first: Int!, $after: String) {
    transactions(accountId: $accountId, first: $first, after: $after) {
      nodes { ...TransactionFields }
      pageInfo { endCursor hasNextPage }
    }
  }
`);

export const AccountUpdatesDocument = graphql(`
  subscription AccountUpdates($accountId: ID!) {
    accountUpdated(accountId: $accountId) {
      eventId sequence
      account { id balance { amount currency } }
      transaction { ...TransactionFields }
    }
  }
`);

export const TransferDocument = graphql(`
  mutation Transfer($input: CreateTransferInput!) {
    createTransfer(input: $input) { replayed transfer { id amount { amount currency } createdAt } }
  }
`);

export const DepositDocument = graphql(`
  mutation Deposit($input: SimulateDepositInput!) {
    simulateDeposit(input: $input) { replayed transfer { id kind amount { amount currency } } }
  }
`);
