// Owns the tokens. Access token: memory only. Refresh token: secure storage
// (Keychain / Keystore via expo-secure-store), never AsyncStorage.
//
// Single-flight refresh: when 5 requests hit UNAUTHENTICATED at once, they all
// await the SAME refresh promise. Firing 5 refreshes would rotate the token 5
// times; the server's reuse detection would then revoke the session.

export type AuthTokens = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
};

export interface RefreshTokenStorage {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Thrown by the refresh call when the server says the session is over. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

export type SessionStatus = 'unknown' | 'signedIn' | 'signedOut';
type Listener = (status: SessionStatus) => void;

/** Refresh this long before expiry, so requests don't race the deadline. */
const EXPIRY_MARGIN_MS = 30_000;

export class SessionManager {
  private access: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string | null> | null = null;
  private status: SessionStatus = 'unknown';
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: RefreshTokenStorage,
    private readonly refreshCall: (refreshToken: string) => Promise<AuthTokens>,
    private readonly now: () => number = Date.now,
  ) {}

  get currentStatus(): SessionStatus {
    return this.status;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** On app start: a stored refresh token means "probably signed in"; prove it. */
  async restore(): Promise<void> {
    const stored = await this.storage.load();
    if (!stored) return this.setStatus('signedOut');
    const token = await this.refresh();
    // Network down at launch: keep the stored token and stay signed in; the
    // next request retries the refresh. Only the server can sign us out.
    if (token === null && this.status !== 'signedOut') this.setStatus('signedIn');
  }

  async signIn(tokens: AuthTokens): Promise<void> {
    await this.accept(tokens);
    this.setStatus('signedIn');
  }

  async signOut(): Promise<void> {
    this.access = null;
    await this.storage.clear();
    this.setStatus('signedOut');
  }

  /** A valid access token, refreshing first if it's missing or about to expire. */
  async getAccessToken(): Promise<string | null> {
    if (this.access && this.access.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.access.token;
    return this.refresh();
  }

  /** Force a refresh (e.g. after an UNAUTHENTICATED response). Coalesced. */
  refresh(): Promise<string | null> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Called after an UNAUTHENTICATED error for `token`: refresh unless someone already did. */
  async refreshAfterRejection(rejectedToken: string | null): Promise<string | null> {
    if (this.access && this.access.token !== rejectedToken) return this.access.token;
    this.access = null;
    return this.refresh();
  }

  private async doRefresh(): Promise<string | null> {
    const refreshToken = await this.storage.load();
    if (!refreshToken) {
      await this.signOut();
      return null;
    }
    try {
      const tokens = await this.refreshCall(refreshToken);
      await this.accept(tokens);
      if (this.status !== 'signedIn') this.setStatus('signedIn');
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof SessionExpiredError) await this.signOut();
      // Network/5xx: keep the refresh token. Retrying it within the server's
      // 30s grace window is safe even if the server already rotated it.
      return null;
    }
  }

  private async accept(tokens: AuthTokens): Promise<void> {
    // Save the new refresh token BEFORE using the new access token: if the
    // app dies right after, the stored token is the current one.
    await this.storage.save(tokens.refreshToken);
    this.access = { token: tokens.accessToken, expiresAt: Date.parse(tokens.accessTokenExpiresAt) };
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
