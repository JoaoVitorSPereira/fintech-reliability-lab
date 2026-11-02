# ADR 0004: Server-side sessions with rotating refresh tokens

**Status:** accepted (Milestone 2)

## Context
The mobile app needs long-lived sign-in (weeks) without long-lived bearer credentials, plus immediate revocation (logout, "sign out other devices", theft response). Mobile networks drop responses mid-flight, and the app may refresh from several places at once.

## Decision
- **Session row per device login.** Absolute lifetime of 90 days.
- **Access token:** HS256 JWT, 15 minutes, claims `sub` (user) and `sid` (session). The guard verifies the signature **and** checks that the session is active on every request (one primary-key lookup), so revocation takes effect immediately.
- **Refresh token:** 256-bit random, single use, 30-day idle timeout capped by the session's absolute lifetime. Only its SHA-256 is stored.
- **Rotation:** every refresh marks the token `rotated_at` and issues a successor. Spent tokens are kept for reuse detection.
- **Reuse detection:** a spent token presented again revokes the whole session (`REFRESH_TOKEN_REUSE`).
- **Grace window (30s):** a spent token whose successor has never been used may be retried. The unused successor is revoked and a new one is issued. This covers "rotation committed, response lost". The window is measured from the first rotation, so retries can't extend it.
- **Concurrency:** every refresh locks the session row (`SELECT … FOR UPDATE`, raw SQL per ADR 0002) and re-reads the token after the lock. A partial unique index guarantees at most one live token per session, even if the locking were wrong.
- **Revocation commits before erroring:** the reuse branch returns instead of throwing, because a throw would roll back the revocation.
- **Authorization:** a global guard; resolvers opt out with `@Public()`. Ownership checks live in `AuthService` queries (`WHERE id = $1 AND user_id = $viewer`), so another user's resource looks exactly like a missing one.

## Alternatives considered
- **Stateless JWT only** (no per-request session check). Saves a query, but logout and theft response would wait up to 15 minutes. Not acceptable for a banking app. If the lookup ever shows up in profiles, cache the active-session check in Redis with explicit invalidation on revoke.
- **Strict reuse detection without a grace window.** Simpler, but logs real users out whenever a response is lost on a bad mobile connection.
- **Opaque access tokens.** Equivalent here, given the per-request lookup. JWT kept because it's part of the brief and carries claims for future consumers (e.g. the WebSocket handshake in Milestone 9).

## Consequences
- A stolen refresh token used by an attacker is detected the next time the legitimate client refreshes. A stolen access token is usable until it expires *or* the session is revoked.
- Within the grace window, an attacker who obtained a just-rotated token could get a fresh token. The legitimate client's next refresh then trips reuse detection and kills the session.
- The client must still single-flight its refreshes (Milestone 10/11). The server tolerates concurrent refreshes, but the client should only keep the last token it received.
- Not yet covered: per-IP rate limits, JWT key rotation (`kid`), password change revoking other sessions, email verification. Registration reveals whether an email is taken (`EMAIL_TAKEN`); accepted until email verification exists.
