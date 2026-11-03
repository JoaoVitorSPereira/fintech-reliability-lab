import { type AuthTokens, SessionExpiredError, SessionManager } from '../session';

function memoryStorage(initial: string | null = 'refresh-0') {
  let value = initial;
  return {
    load: jest.fn(async () => value),
    save: jest.fn(async (token: string) => { value = token; }),
    clear: jest.fn(async () => { value = null; }),
    get value() { return value; },
  };
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

function tokens(n: number, expiresInMs = 15 * 60_000): AuthTokens {
  return { accessToken: `access-${n}`, accessTokenExpiresAt: later(expiresInMs), refreshToken: `refresh-${n}` };
}

describe('SessionManager', () => {
  it('runs ONE refresh for many concurrent callers (single-flight)', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const refresh = jest.fn(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tokens(calls);
    });
    const session = new SessionManager(storage, refresh);

    const results = await Promise.all(Array.from({ length: 5 }, () => session.getAccessToken()));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results).toEqual(Array(5).fill('access-1'));
    expect(storage.value).toBe('refresh-1');
  });

  it('does not refresh again when another request already replaced the rejected token', async () => {
    const refresh = jest.fn(async () => tokens(2));
    const session = new SessionManager(memoryStorage(), refresh);
    await session.signIn(tokens(1));

    await session.refreshAfterRejection('access-1'); // first 401: refreshes
    const second = await session.refreshAfterRejection('access-1'); // stale 401 for the old token

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(second).toBe('access-2');
  });

  it('refreshes proactively shortly before the access token expires', async () => {
    const refresh = jest.fn(async () => tokens(2));
    const session = new SessionManager(memoryStorage(), refresh);
    await session.signIn(tokens(1, 10_000)); // expires in 10s, inside the 30s margin
    expect(await session.getAccessToken()).toBe('access-2');
  });

  it('signs out only when the server rejects the session', async () => {
    const storage = memoryStorage();
    const session = new SessionManager(storage, async () => { throw new SessionExpiredError(); });
    const statuses: string[] = [];
    session.subscribe((status) => statuses.push(status));

    expect(await session.refresh()).toBeNull();
    expect(statuses).toEqual(['signedOut']);
    expect(storage.value).toBeNull();
  });

  it('keeps the refresh token on network errors (the server grace window makes retry safe)', async () => {
    const storage = memoryStorage();
    const session = new SessionManager(storage, async () => { throw new TypeError('Network request failed'); });
    expect(await session.refresh()).toBeNull();
    expect(storage.value).toBe('refresh-0');
    expect(session.currentStatus).not.toBe('signedOut');
  });

  it('stores the new refresh token before handing out the new access token', async () => {
    const storage = memoryStorage();
    const session = new SessionManager(storage, async () => tokens(7));
    await session.refresh();
    expect(storage.save).toHaveBeenCalledWith('refresh-7');
  });
});
