/* eslint-disable */
import * as types from './graphql';
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';

/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  fragment QuoteFields on MarketPrice {\n    assetId price currency change24h volume24h marketCap provider sourceTimestamp isStale dataQuality marketStatus\n  }\n": typeof types.QuoteFieldsFragmentDoc,
    "\n  fragment AssetRowFields on Asset {\n    id symbol name category logoUrl marketCapRank quoteCurrency sparkline\n    quote { ...QuoteFields }\n  }\n": typeof types.AssetRowFieldsFragmentDoc,
    "\n  mutation SignIn($input: LoginInput!) {\n    login(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n": typeof types.SignInDocument,
    "\n  mutation SignUp($input: RegisterInput!) {\n    register(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n": typeof types.SignUpDocument,
    "mutation Logout { logout }": typeof types.LogoutDocument,
    "\n  query Me {\n    me { id email createdAt }\n    sessions { id deviceName createdAt lastRefreshedAt current }\n  }\n": typeof types.MeDocument,
    "mutation RevokeSession($id: ID!) { revokeSession(id: $id) }": typeof types.RevokeSessionDocument,
    "\n  query Dashboard {\n    portfolio {\n      id totalValue { amount currency } dayChange { amount currency } totalPnl { amount currency } valuationIsStale\n      totalReturnPct cashAllocationPct positions { allocationPct asset { id symbol } }\n    }\n    marketOverview {\n      totalMarketCapUsd marketCapChange24hPct btcDominancePct asOf\n      topGainers { ...AssetRowFields }\n      topLosers { ...AssetRowFields }\n      mostTraded { ...AssetRowFields }\n      mostVolatile { ...AssetRowFields volatility { annualized7dPct } }\n      indexProxies { ...AssetRowFields }\n      providers { name status note }\n    }\n    watchlist { addedAt asset { ...AssetRowFields } }\n  }\n": typeof types.DashboardDocument,
    "\n  query Assets($first: Int!, $after: String, $category: AssetCategory, $search: String, $sort: AssetSort) {\n    assets(first: $first, after: $after, category: $category, search: $search, sort: $sort) {\n      totalCount\n      nodes { ...AssetRowFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n": typeof types.AssetsDocument,
    "\n  query AssetDetail($id: ID!) {\n    asset(id: $id) {\n      ...AssetRowFields supportedTimeframes\n      volatility { annualized24hPct annualized7dPct range24hPct sampleHours }\n    }\n    watchlist { asset { id } }\n  }\n": typeof types.AssetDetailDocument,
    "\n  query AssetCandles($id: ID!, $timeframe: ChartTimeframe!, $from: DateTime!, $to: DateTime!) {\n    assetCandles(assetId: $id, timeframe: $timeframe, from: $from, to: $to) {\n      provider isStale isComplete note\n      candles { openTime open high low close volume isClosed }\n    }\n  }\n": typeof types.AssetCandlesDocument,
    "\n  mutation AddToWatchlist($assetId: ID!) { createWatchlistItem(assetId: $assetId) { addedAt asset { id } } }\n": typeof types.AddToWatchlistDocument,
    "\n  mutation RemoveFromWatchlist($assetId: ID!) { removeWatchlistItem(assetId: $assetId) }\n": typeof types.RemoveFromWatchlistDocument,
    "\n  subscription PriceUpdates($assetIds: [ID!]!, $minIntervalMs: Int) {\n    marketPriceUpdated(assetIds: $assetIds, minIntervalMs: $minIntervalMs) {\n      assetId price currency change24h sourceTimestamp dataQuality\n    }\n  }\n": typeof types.PriceUpdatesDocument,
    "\n  query Portfolio($range: PerformanceRange) {\n    portfolio {\n      id cashAccountId isSimulated valuationIsStale\n      cash { amount currency } reservedCash { amount currency } marketValue { amount currency }\n      totalValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n      totalPnl { amount currency } dayChange { amount currency } cashAllocationPct\n      totalReturnPct netDeposits { amount currency }\n      positions {\n        quantity reservedQuantity averagePrice allocationPct unrealizedPnlPct priceIsStale\n        costBasis { amount currency } marketValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n        asset { ...AssetRowFields }\n      }\n      performance(range: $range) { at totalValue { amount currency } isStale }\n    }\n  }\n": typeof types.PortfolioDocument,
    "mutation CreatePortfolio { createPortfolio { id cashAccountId } }": typeof types.CreatePortfolioDocument,
    "\n  fragment OrderFields on SimulatedOrder {\n    id portfolioId side type status quantity limitPrice rejectReason createdAt filledAt cancelledAt isSimulated disclaimer\n    reservedCash { amount currency }\n    asset { id symbol name }\n    trade { id price quantity priceProvider priceTimestamp notional { amount currency } realizedPnl { amount currency } }\n  }\n": typeof types.OrderFieldsFragmentDoc,
    "\n  query Orders($first: Int!, $after: String) {\n    simulatedOrders(first: $first, after: $after) { nodes { ...OrderFields } pageInfo { endCursor hasNextPage } }\n  }\n": typeof types.OrdersDocument,
    "\n  mutation PlaceOrder($input: SimulatedOrderInput!) {\n    createSimulatedOrder(input: $input) { replayed order { ...OrderFields } }\n  }\n": typeof types.PlaceOrderDocument,
    "\n  mutation CancelOrder($id: ID!) { cancelSimulatedOrder(orderId: $id) { replayed order { ...OrderFields } } }\n": typeof types.CancelOrderDocument,
    "\n  subscription OrderUpdates($portfolioId: ID!) {\n    simulatedOrderUpdated(portfolioId: $portfolioId) { eventId sequence order { ...OrderFields } }\n  }\n": typeof types.OrderUpdatesDocument,
    "\n  query Accounts { accounts { id currency purpose createdAt balance { amount currency } } }\n": typeof types.AccountsDocument,
    "\n  fragment TransactionFields on Transaction { id transactionId kind description createdAt amount { amount currency } }\n": typeof types.TransactionFieldsFragmentDoc,
    "\n  query Transactions($accountId: ID!, $first: Int!, $after: String) {\n    transactions(accountId: $accountId, first: $first, after: $after) {\n      nodes { ...TransactionFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n": typeof types.TransactionsDocument,
    "\n  subscription AccountUpdates($accountId: ID!) {\n    accountUpdated(accountId: $accountId) {\n      eventId sequence\n      account { id balance { amount currency } }\n      transaction { ...TransactionFields }\n    }\n  }\n": typeof types.AccountUpdatesDocument,
    "\n  mutation Transfer($input: CreateTransferInput!) {\n    createTransfer(input: $input) { replayed transfer { id amount { amount currency } createdAt } }\n  }\n": typeof types.TransferDocument,
    "\n  mutation Deposit($input: SimulateDepositInput!) {\n    simulateDeposit(input: $input) { replayed transfer { id kind amount { amount currency } } }\n  }\n": typeof types.DepositDocument,
};
const documents: Documents = {
    "\n  fragment QuoteFields on MarketPrice {\n    assetId price currency change24h volume24h marketCap provider sourceTimestamp isStale dataQuality marketStatus\n  }\n": types.QuoteFieldsFragmentDoc,
    "\n  fragment AssetRowFields on Asset {\n    id symbol name category logoUrl marketCapRank quoteCurrency sparkline\n    quote { ...QuoteFields }\n  }\n": types.AssetRowFieldsFragmentDoc,
    "\n  mutation SignIn($input: LoginInput!) {\n    login(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n": types.SignInDocument,
    "\n  mutation SignUp($input: RegisterInput!) {\n    register(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n": types.SignUpDocument,
    "mutation Logout { logout }": types.LogoutDocument,
    "\n  query Me {\n    me { id email createdAt }\n    sessions { id deviceName createdAt lastRefreshedAt current }\n  }\n": types.MeDocument,
    "mutation RevokeSession($id: ID!) { revokeSession(id: $id) }": types.RevokeSessionDocument,
    "\n  query Dashboard {\n    portfolio {\n      id totalValue { amount currency } dayChange { amount currency } totalPnl { amount currency } valuationIsStale\n      totalReturnPct cashAllocationPct positions { allocationPct asset { id symbol } }\n    }\n    marketOverview {\n      totalMarketCapUsd marketCapChange24hPct btcDominancePct asOf\n      topGainers { ...AssetRowFields }\n      topLosers { ...AssetRowFields }\n      mostTraded { ...AssetRowFields }\n      mostVolatile { ...AssetRowFields volatility { annualized7dPct } }\n      indexProxies { ...AssetRowFields }\n      providers { name status note }\n    }\n    watchlist { addedAt asset { ...AssetRowFields } }\n  }\n": types.DashboardDocument,
    "\n  query Assets($first: Int!, $after: String, $category: AssetCategory, $search: String, $sort: AssetSort) {\n    assets(first: $first, after: $after, category: $category, search: $search, sort: $sort) {\n      totalCount\n      nodes { ...AssetRowFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n": types.AssetsDocument,
    "\n  query AssetDetail($id: ID!) {\n    asset(id: $id) {\n      ...AssetRowFields supportedTimeframes\n      volatility { annualized24hPct annualized7dPct range24hPct sampleHours }\n    }\n    watchlist { asset { id } }\n  }\n": types.AssetDetailDocument,
    "\n  query AssetCandles($id: ID!, $timeframe: ChartTimeframe!, $from: DateTime!, $to: DateTime!) {\n    assetCandles(assetId: $id, timeframe: $timeframe, from: $from, to: $to) {\n      provider isStale isComplete note\n      candles { openTime open high low close volume isClosed }\n    }\n  }\n": types.AssetCandlesDocument,
    "\n  mutation AddToWatchlist($assetId: ID!) { createWatchlistItem(assetId: $assetId) { addedAt asset { id } } }\n": types.AddToWatchlistDocument,
    "\n  mutation RemoveFromWatchlist($assetId: ID!) { removeWatchlistItem(assetId: $assetId) }\n": types.RemoveFromWatchlistDocument,
    "\n  subscription PriceUpdates($assetIds: [ID!]!, $minIntervalMs: Int) {\n    marketPriceUpdated(assetIds: $assetIds, minIntervalMs: $minIntervalMs) {\n      assetId price currency change24h sourceTimestamp dataQuality\n    }\n  }\n": types.PriceUpdatesDocument,
    "\n  query Portfolio($range: PerformanceRange) {\n    portfolio {\n      id cashAccountId isSimulated valuationIsStale\n      cash { amount currency } reservedCash { amount currency } marketValue { amount currency }\n      totalValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n      totalPnl { amount currency } dayChange { amount currency } cashAllocationPct\n      totalReturnPct netDeposits { amount currency }\n      positions {\n        quantity reservedQuantity averagePrice allocationPct unrealizedPnlPct priceIsStale\n        costBasis { amount currency } marketValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n        asset { ...AssetRowFields }\n      }\n      performance(range: $range) { at totalValue { amount currency } isStale }\n    }\n  }\n": types.PortfolioDocument,
    "mutation CreatePortfolio { createPortfolio { id cashAccountId } }": types.CreatePortfolioDocument,
    "\n  fragment OrderFields on SimulatedOrder {\n    id portfolioId side type status quantity limitPrice rejectReason createdAt filledAt cancelledAt isSimulated disclaimer\n    reservedCash { amount currency }\n    asset { id symbol name }\n    trade { id price quantity priceProvider priceTimestamp notional { amount currency } realizedPnl { amount currency } }\n  }\n": types.OrderFieldsFragmentDoc,
    "\n  query Orders($first: Int!, $after: String) {\n    simulatedOrders(first: $first, after: $after) { nodes { ...OrderFields } pageInfo { endCursor hasNextPage } }\n  }\n": types.OrdersDocument,
    "\n  mutation PlaceOrder($input: SimulatedOrderInput!) {\n    createSimulatedOrder(input: $input) { replayed order { ...OrderFields } }\n  }\n": types.PlaceOrderDocument,
    "\n  mutation CancelOrder($id: ID!) { cancelSimulatedOrder(orderId: $id) { replayed order { ...OrderFields } } }\n": types.CancelOrderDocument,
    "\n  subscription OrderUpdates($portfolioId: ID!) {\n    simulatedOrderUpdated(portfolioId: $portfolioId) { eventId sequence order { ...OrderFields } }\n  }\n": types.OrderUpdatesDocument,
    "\n  query Accounts { accounts { id currency purpose createdAt balance { amount currency } } }\n": types.AccountsDocument,
    "\n  fragment TransactionFields on Transaction { id transactionId kind description createdAt amount { amount currency } }\n": types.TransactionFieldsFragmentDoc,
    "\n  query Transactions($accountId: ID!, $first: Int!, $after: String) {\n    transactions(accountId: $accountId, first: $first, after: $after) {\n      nodes { ...TransactionFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n": types.TransactionsDocument,
    "\n  subscription AccountUpdates($accountId: ID!) {\n    accountUpdated(accountId: $accountId) {\n      eventId sequence\n      account { id balance { amount currency } }\n      transaction { ...TransactionFields }\n    }\n  }\n": types.AccountUpdatesDocument,
    "\n  mutation Transfer($input: CreateTransferInput!) {\n    createTransfer(input: $input) { replayed transfer { id amount { amount currency } createdAt } }\n  }\n": types.TransferDocument,
    "\n  mutation Deposit($input: SimulateDepositInput!) {\n    simulateDeposit(input: $input) { replayed transfer { id kind amount { amount currency } } }\n  }\n": types.DepositDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 *
 *
 * @example
 * ```ts
 * const query = graphql(`query GetUser($id: ID!) { user(id: $id) { name } }`);
 * ```
 *
 * The query argument is unknown!
 * Please regenerate the types.
 */
export function graphql(source: string): unknown;

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment QuoteFields on MarketPrice {\n    assetId price currency change24h volume24h marketCap provider sourceTimestamp isStale dataQuality marketStatus\n  }\n"): (typeof documents)["\n  fragment QuoteFields on MarketPrice {\n    assetId price currency change24h volume24h marketCap provider sourceTimestamp isStale dataQuality marketStatus\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment AssetRowFields on Asset {\n    id symbol name category logoUrl marketCapRank quoteCurrency sparkline\n    quote { ...QuoteFields }\n  }\n"): (typeof documents)["\n  fragment AssetRowFields on Asset {\n    id symbol name category logoUrl marketCapRank quoteCurrency sparkline\n    quote { ...QuoteFields }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SignIn($input: LoginInput!) {\n    login(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n"): (typeof documents)["\n  mutation SignIn($input: LoginInput!) {\n    login(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SignUp($input: RegisterInput!) {\n    register(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n"): (typeof documents)["\n  mutation SignUp($input: RegisterInput!) {\n    register(input: $input) { accessToken accessTokenExpiresAt refreshToken user { id email } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "mutation Logout { logout }"): (typeof documents)["mutation Logout { logout }"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Me {\n    me { id email createdAt }\n    sessions { id deviceName createdAt lastRefreshedAt current }\n  }\n"): (typeof documents)["\n  query Me {\n    me { id email createdAt }\n    sessions { id deviceName createdAt lastRefreshedAt current }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "mutation RevokeSession($id: ID!) { revokeSession(id: $id) }"): (typeof documents)["mutation RevokeSession($id: ID!) { revokeSession(id: $id) }"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Dashboard {\n    portfolio {\n      id totalValue { amount currency } dayChange { amount currency } totalPnl { amount currency } valuationIsStale\n      totalReturnPct cashAllocationPct positions { allocationPct asset { id symbol } }\n    }\n    marketOverview {\n      totalMarketCapUsd marketCapChange24hPct btcDominancePct asOf\n      topGainers { ...AssetRowFields }\n      topLosers { ...AssetRowFields }\n      mostTraded { ...AssetRowFields }\n      mostVolatile { ...AssetRowFields volatility { annualized7dPct } }\n      indexProxies { ...AssetRowFields }\n      providers { name status note }\n    }\n    watchlist { addedAt asset { ...AssetRowFields } }\n  }\n"): (typeof documents)["\n  query Dashboard {\n    portfolio {\n      id totalValue { amount currency } dayChange { amount currency } totalPnl { amount currency } valuationIsStale\n      totalReturnPct cashAllocationPct positions { allocationPct asset { id symbol } }\n    }\n    marketOverview {\n      totalMarketCapUsd marketCapChange24hPct btcDominancePct asOf\n      topGainers { ...AssetRowFields }\n      topLosers { ...AssetRowFields }\n      mostTraded { ...AssetRowFields }\n      mostVolatile { ...AssetRowFields volatility { annualized7dPct } }\n      indexProxies { ...AssetRowFields }\n      providers { name status note }\n    }\n    watchlist { addedAt asset { ...AssetRowFields } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Assets($first: Int!, $after: String, $category: AssetCategory, $search: String, $sort: AssetSort) {\n    assets(first: $first, after: $after, category: $category, search: $search, sort: $sort) {\n      totalCount\n      nodes { ...AssetRowFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n"): (typeof documents)["\n  query Assets($first: Int!, $after: String, $category: AssetCategory, $search: String, $sort: AssetSort) {\n    assets(first: $first, after: $after, category: $category, search: $search, sort: $sort) {\n      totalCount\n      nodes { ...AssetRowFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query AssetDetail($id: ID!) {\n    asset(id: $id) {\n      ...AssetRowFields supportedTimeframes\n      volatility { annualized24hPct annualized7dPct range24hPct sampleHours }\n    }\n    watchlist { asset { id } }\n  }\n"): (typeof documents)["\n  query AssetDetail($id: ID!) {\n    asset(id: $id) {\n      ...AssetRowFields supportedTimeframes\n      volatility { annualized24hPct annualized7dPct range24hPct sampleHours }\n    }\n    watchlist { asset { id } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query AssetCandles($id: ID!, $timeframe: ChartTimeframe!, $from: DateTime!, $to: DateTime!) {\n    assetCandles(assetId: $id, timeframe: $timeframe, from: $from, to: $to) {\n      provider isStale isComplete note\n      candles { openTime open high low close volume isClosed }\n    }\n  }\n"): (typeof documents)["\n  query AssetCandles($id: ID!, $timeframe: ChartTimeframe!, $from: DateTime!, $to: DateTime!) {\n    assetCandles(assetId: $id, timeframe: $timeframe, from: $from, to: $to) {\n      provider isStale isComplete note\n      candles { openTime open high low close volume isClosed }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation AddToWatchlist($assetId: ID!) { createWatchlistItem(assetId: $assetId) { addedAt asset { id } } }\n"): (typeof documents)["\n  mutation AddToWatchlist($assetId: ID!) { createWatchlistItem(assetId: $assetId) { addedAt asset { id } } }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RemoveFromWatchlist($assetId: ID!) { removeWatchlistItem(assetId: $assetId) }\n"): (typeof documents)["\n  mutation RemoveFromWatchlist($assetId: ID!) { removeWatchlistItem(assetId: $assetId) }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  subscription PriceUpdates($assetIds: [ID!]!, $minIntervalMs: Int) {\n    marketPriceUpdated(assetIds: $assetIds, minIntervalMs: $minIntervalMs) {\n      assetId price currency change24h sourceTimestamp dataQuality\n    }\n  }\n"): (typeof documents)["\n  subscription PriceUpdates($assetIds: [ID!]!, $minIntervalMs: Int) {\n    marketPriceUpdated(assetIds: $assetIds, minIntervalMs: $minIntervalMs) {\n      assetId price currency change24h sourceTimestamp dataQuality\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Portfolio($range: PerformanceRange) {\n    portfolio {\n      id cashAccountId isSimulated valuationIsStale\n      cash { amount currency } reservedCash { amount currency } marketValue { amount currency }\n      totalValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n      totalPnl { amount currency } dayChange { amount currency } cashAllocationPct\n      totalReturnPct netDeposits { amount currency }\n      positions {\n        quantity reservedQuantity averagePrice allocationPct unrealizedPnlPct priceIsStale\n        costBasis { amount currency } marketValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n        asset { ...AssetRowFields }\n      }\n      performance(range: $range) { at totalValue { amount currency } isStale }\n    }\n  }\n"): (typeof documents)["\n  query Portfolio($range: PerformanceRange) {\n    portfolio {\n      id cashAccountId isSimulated valuationIsStale\n      cash { amount currency } reservedCash { amount currency } marketValue { amount currency }\n      totalValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n      totalPnl { amount currency } dayChange { amount currency } cashAllocationPct\n      totalReturnPct netDeposits { amount currency }\n      positions {\n        quantity reservedQuantity averagePrice allocationPct unrealizedPnlPct priceIsStale\n        costBasis { amount currency } marketValue { amount currency } unrealizedPnl { amount currency } realizedPnl { amount currency }\n        asset { ...AssetRowFields }\n      }\n      performance(range: $range) { at totalValue { amount currency } isStale }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "mutation CreatePortfolio { createPortfolio { id cashAccountId } }"): (typeof documents)["mutation CreatePortfolio { createPortfolio { id cashAccountId } }"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment OrderFields on SimulatedOrder {\n    id portfolioId side type status quantity limitPrice rejectReason createdAt filledAt cancelledAt isSimulated disclaimer\n    reservedCash { amount currency }\n    asset { id symbol name }\n    trade { id price quantity priceProvider priceTimestamp notional { amount currency } realizedPnl { amount currency } }\n  }\n"): (typeof documents)["\n  fragment OrderFields on SimulatedOrder {\n    id portfolioId side type status quantity limitPrice rejectReason createdAt filledAt cancelledAt isSimulated disclaimer\n    reservedCash { amount currency }\n    asset { id symbol name }\n    trade { id price quantity priceProvider priceTimestamp notional { amount currency } realizedPnl { amount currency } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Orders($first: Int!, $after: String) {\n    simulatedOrders(first: $first, after: $after) { nodes { ...OrderFields } pageInfo { endCursor hasNextPage } }\n  }\n"): (typeof documents)["\n  query Orders($first: Int!, $after: String) {\n    simulatedOrders(first: $first, after: $after) { nodes { ...OrderFields } pageInfo { endCursor hasNextPage } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation PlaceOrder($input: SimulatedOrderInput!) {\n    createSimulatedOrder(input: $input) { replayed order { ...OrderFields } }\n  }\n"): (typeof documents)["\n  mutation PlaceOrder($input: SimulatedOrderInput!) {\n    createSimulatedOrder(input: $input) { replayed order { ...OrderFields } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CancelOrder($id: ID!) { cancelSimulatedOrder(orderId: $id) { replayed order { ...OrderFields } } }\n"): (typeof documents)["\n  mutation CancelOrder($id: ID!) { cancelSimulatedOrder(orderId: $id) { replayed order { ...OrderFields } } }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  subscription OrderUpdates($portfolioId: ID!) {\n    simulatedOrderUpdated(portfolioId: $portfolioId) { eventId sequence order { ...OrderFields } }\n  }\n"): (typeof documents)["\n  subscription OrderUpdates($portfolioId: ID!) {\n    simulatedOrderUpdated(portfolioId: $portfolioId) { eventId sequence order { ...OrderFields } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Accounts { accounts { id currency purpose createdAt balance { amount currency } } }\n"): (typeof documents)["\n  query Accounts { accounts { id currency purpose createdAt balance { amount currency } } }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment TransactionFields on Transaction { id transactionId kind description createdAt amount { amount currency } }\n"): (typeof documents)["\n  fragment TransactionFields on Transaction { id transactionId kind description createdAt amount { amount currency } }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Transactions($accountId: ID!, $first: Int!, $after: String) {\n    transactions(accountId: $accountId, first: $first, after: $after) {\n      nodes { ...TransactionFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n"): (typeof documents)["\n  query Transactions($accountId: ID!, $first: Int!, $after: String) {\n    transactions(accountId: $accountId, first: $first, after: $after) {\n      nodes { ...TransactionFields }\n      pageInfo { endCursor hasNextPage }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  subscription AccountUpdates($accountId: ID!) {\n    accountUpdated(accountId: $accountId) {\n      eventId sequence\n      account { id balance { amount currency } }\n      transaction { ...TransactionFields }\n    }\n  }\n"): (typeof documents)["\n  subscription AccountUpdates($accountId: ID!) {\n    accountUpdated(accountId: $accountId) {\n      eventId sequence\n      account { id balance { amount currency } }\n      transaction { ...TransactionFields }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation Transfer($input: CreateTransferInput!) {\n    createTransfer(input: $input) { replayed transfer { id amount { amount currency } createdAt } }\n  }\n"): (typeof documents)["\n  mutation Transfer($input: CreateTransferInput!) {\n    createTransfer(input: $input) { replayed transfer { id amount { amount currency } createdAt } }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation Deposit($input: SimulateDepositInput!) {\n    simulateDeposit(input: $input) { replayed transfer { id kind amount { amount currency } } }\n  }\n"): (typeof documents)["\n  mutation Deposit($input: SimulateDepositInput!) {\n    simulateDeposit(input: $input) { replayed transfer { id kind amount { amount currency } } }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;