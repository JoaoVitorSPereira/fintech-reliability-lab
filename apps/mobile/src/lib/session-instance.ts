import * as SecureStore from 'expo-secure-store';
import { config } from './config';
import { type AuthTokens, SessionExpiredError, SessionManager } from './session';

const REFRESH_TOKEN_KEY = 'fintech.refreshToken';

const REFRESH_MUTATION = `mutation RefreshSession($token: String!) {
  refreshSession(refreshToken: $token) { accessToken accessTokenExpiresAt refreshToken }
}`;

// Plain fetch, outside Apollo's link chain: the refresh must never trigger
// the error link that triggers a refresh (infinite loop).
async function refreshCall(refreshToken: string): Promise<AuthTokens> {
  const response = await fetch(config.httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: REFRESH_MUTATION, variables: { token: refreshToken } }),
  });
  if (!response.ok) throw new Error(`refresh failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    data?: { refreshSession: AuthTokens } | null;
    errors?: { extensions?: { code?: string } }[];
  };
  if (body.errors?.some((error) => error.extensions?.code === 'UNAUTHENTICATED')) throw new SessionExpiredError();
  if (!body.data?.refreshSession) throw new Error('refresh failed');
  return body.data.refreshSession;
}

export const session = new SessionManager(
  {
    load: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
    save: (token) => SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, {
      // Not readable before first unlock, never synced to iCloud backups.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
    clear: () => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
  },
  refreshCall,
);
