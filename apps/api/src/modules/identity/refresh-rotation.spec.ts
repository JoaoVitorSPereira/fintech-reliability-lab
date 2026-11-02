import {
  REFRESH_REUSE_GRACE_MS,
  decideRefresh,
  type RefreshTokenState,
  type SessionState,
} from './refresh-rotation';

const now = new Date('2026-01-01T12:00:00Z');
const later = new Date(now.getTime() + 86_400_000);
const ago = (ms: number) => new Date(now.getTime() - ms);

const liveSession: SessionState = { expiresAt: later, revokedAt: null };
const unused = { expiresAt: later, rotatedAt: null, revokedAt: null };

function token(overrides: Partial<RefreshTokenState> = {}): RefreshTokenState {
  return { ...unused, replacedBy: null, ...overrides };
}

describe('decideRefresh', () => {
  it('rotates a current token', () => {
    expect(decideRefresh(token(), liveSession, now)).toBe('rotate');
  });

  it('rejects when the session is revoked or past its absolute lifetime', () => {
    expect(
      decideRefresh(token(), { ...liveSession, revokedAt: ago(1) }, now),
    ).toBe('reject');
    expect(
      decideRefresh(token(), { ...liveSession, expiresAt: now }, now),
    ).toBe('reject');
  });

  it('rejects an expired token', () => {
    expect(decideRefresh(token({ expiresAt: now }), liveSession, now)).toBe(
      'reject',
    );
  });

  it('reissues when a just-rotated token is retried and its successor was never used', () => {
    const retried = token({ rotatedAt: ago(5_000), replacedBy: unused });
    expect(decideRefresh(retried, liveSession, now)).toBe('reissue');
  });

  it('revokes the session when the successor was already used', () => {
    const replayed = token({
      rotatedAt: ago(5_000),
      replacedBy: { ...unused, rotatedAt: ago(1_000) },
    });
    expect(decideRefresh(replayed, liveSession, now)).toBe('revoke-session');
  });

  it('revokes the session when a rotated token returns after the grace window', () => {
    const stale = token({
      rotatedAt: ago(REFRESH_REUSE_GRACE_MS + 1),
      replacedBy: unused,
    });
    expect(decideRefresh(stale, liveSession, now)).toBe('revoke-session');
  });

  it('revokes the session when a revoked token is presented', () => {
    expect(decideRefresh(token({ revokedAt: ago(1) }), liveSession, now)).toBe(
      'revoke-session',
    );
  });
});
