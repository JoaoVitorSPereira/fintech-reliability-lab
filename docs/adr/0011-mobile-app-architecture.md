# ADR 0011: Mobile app architecture

**Status:** accepted (Milestone 10)

## Context
The app shows money, live prices and orders over flaky mobile networks. It must never double-submit a financial operation, never show stale data as live, and keep tokens safe on the device.

## Decision
- **Expo SDK 58, Expo Router, native tabs; runs in Expo Go.** That constrained native libraries to what Expo Go bundles. Victory Native 43 requires the renamed `react-native-skia` package, so it was pinned to **42.0.1** (on `@shopify/react-native-skia`).
- **Apollo Client 4 is the only server-state store.**
  - Normalized cache, with `MarketPrice` keyed by `assetId`.
  - Cursor-connection merges (a first page replaces, next pages append and dedupe).
  - `cache-and-network` by default; `network-only` for security screens.
- **Zustand for UI-only state**, read with selectors. TanStack Query and Axios are not used: there is no REST integration.
- **Links, in order:**
  1. `RetryLink`: network errors only; queries and idempotency-keyed mutations only.
  2. `SetContextLink`: fresh access token, proactive refresh 30s before expiry.
  3. `ErrorLink`: on `UNAUTHENTICATED`, one shared refresh, replay once (guarded against loops).
  4. `HttpLink`.
  - Subscriptions go through `GraphQLWsLink`. `connectionParams` reads the current token on every (re)connect; close code `4401` triggers a refresh; reconnects refetch active queries.
- **SessionManager:** access token in memory, refresh token in SecureStore (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`). The refresh token is saved before the new access token is used. Only a server rejection signs the user out; network errors keep the token.
- **Idempotency key per user intent** (`useIdempotencyKey`), rotated only after the server confirms.
- **No optimistic UI for money.** Only the watchlist is optimistic.
- **Exact money formatting** from strings. Charts are the only place values become numbers.
- **Codegen from the API's committed SDL;** CI fails if generated types drift.

## Consequences
- Adding a native module outside Expo Go's set requires a development build.
- Every price tick updates one normalized object; list rows are memoized so only that row re-renders.
- Not done: device profiling, offline persistence of the cache, push notifications, biometric unlock and app attestation (natural next steps for a real banking app).
