// How long a just-rotated refresh token may be presented again without being
// treated as theft. Covers "server committed the rotation, the response never
// reached the phone, the app retried with the old token".
export const REFRESH_REUSE_GRACE_MS = 30_000;

type TokenLifecycle = {
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
};

export type RefreshTokenState = TokenLifecycle & {
  /** The token this one was exchanged for, if any. */
  replacedBy: TokenLifecycle | null;
};

export type SessionState = { expiresAt: Date; revokedAt: Date | null };

export type RefreshDecision =
  /** Current token: exchange it for a new one. */
  | 'rotate'
  /** Retry of a just-rotated token whose successor was never used. */
  | 'reissue'
  /** Expired or dead session: deny, change nothing. */
  | 'reject'
  /** A spent token came back after its successor was in use: theft signal. */
  | 'revoke-session';

export function decideRefresh(
  token: RefreshTokenState,
  session: SessionState,
  now: Date,
): RefreshDecision {
  if (session.revokedAt || session.expiresAt <= now) return 'reject';
  if (token.expiresAt <= now) return 'reject';

  // Revoked tokens are only produced by a reissue. If one comes back, someone
  // is holding a token the legitimate client should have discarded.
  if (token.revokedAt) return 'revoke-session';

  if (!token.rotatedAt) return 'rotate';

  const successor = token.replacedBy;
  const successorUnused =
    successor !== null && !successor.rotatedAt && !successor.revokedAt;
  const withinGrace =
    now.getTime() - token.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;

  // Grace is measured from the FIRST rotation, so retries can't extend it.
  if (withinGrace && successorUnused) return 'reissue';

  return 'revoke-session';
}
