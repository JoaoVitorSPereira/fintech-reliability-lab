import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { errorCode, gql } from './graphql';

const PASSWORD = 'a perfectly long passphrase';

const REGISTER = /* GraphQL */ `
  mutation Register($input: RegisterInput!) {
    register(input: $input) {
      accessToken
      refreshToken
      user {
        id
        email
      }
    }
  }
`;
const LOGIN = /* GraphQL */ `
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      accessToken
      refreshToken
      user {
        id
        email
      }
    }
  }
`;
const REFRESH = /* GraphQL */ `
  mutation Refresh($token: String!) {
    refreshSession(refreshToken: $token) {
      accessToken
      refreshToken
    }
  }
`;
const ME = '{ me { id email } }';

type Tokens = { accessToken: string; refreshToken: string };
type AuthData = Tokens & { user: { id: string; email: string } };

// Unique emails per test: suites run in parallel against one database, and
// nothing needs truncating between runs.
function uniqueEmail() {
  return `user-${randomUUID()}@example.com`;
}

describe('Identity (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(email = uniqueEmail(), deviceName?: string) {
    const res = await gql<{ register: AuthData }>(app, REGISTER, {
      input: { email, password: PASSWORD, deviceName },
    });
    expect(res.errors).toBeUndefined();
    return res.data!.register;
  }

  async function refresh(token: string) {
    return gql<{ refreshSession: Tokens }>(app, REFRESH, { token });
  }

  async function sessionOf(refreshToken: string) {
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const row = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash },
      include: { session: true },
    });
    return row.session;
  }

  describe('registration', () => {
    it('creates an account and signs the user in', async () => {
      const auth = await register();
      const me = await gql<{ me: { id: string } }>(
        app,
        ME,
        {},
        auth.accessToken,
      );
      expect(me.data?.me.id).toBe(auth.user.id);
    });

    it('normalizes email so case and spaces cannot create duplicates', async () => {
      const local = `Mixed-${randomUUID()}`;
      const auth = await register(`  ${local}@Example.COM `);
      expect(auth.user.email).toBe(`${local.toLowerCase()}@example.com`);

      const again = await gql(app, REGISTER, {
        input: {
          email: `${local.toUpperCase()}@example.com`,
          password: PASSWORD,
        },
      });
      expect(errorCode(again)).toBe('EMAIL_TAKEN');
    });

    it('lets exactly one of several concurrent sign-ups with the same email win', async () => {
      const email = uniqueEmail();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          gql(app, REGISTER, { input: { email, password: PASSWORD } }),
        ),
      );

      expect(results.filter((r) => !r.errors)).toHaveLength(1);
      expect(
        results.filter((r) => errorCode(r) === 'EMAIL_TAKEN'),
      ).toHaveLength(4);
    });

    it('rejects short passwords with a readable message', async () => {
      const res = await gql(app, REGISTER, {
        input: { email: uniqueEmail(), password: 'short' },
      });
      expect(errorCode(res)).toBe('BAD_USER_INPUT');
      expect(res.errors?.[0]?.message).toMatch(/at least 15 characters/);
    });
  });

  describe('login', () => {
    it('signs in with the right password, in any email case', async () => {
      const { user } = await register();
      const res = await gql<{ login: AuthData }>(app, LOGIN, {
        input: { email: user.email.toUpperCase(), password: PASSWORD },
      });
      expect(res.data?.login.user.id).toBe(user.id);
    });

    it('answers identically for a wrong password and an unknown email', async () => {
      const { user } = await register();
      const wrongPassword = await gql(app, LOGIN, {
        input: { email: user.email, password: 'not the password at all' },
      });
      const unknownEmail = await gql(app, LOGIN, {
        input: { email: uniqueEmail(), password: PASSWORD },
      });

      expect(wrongPassword.errors).toEqual(unknownEmail.errors);
      expect(errorCode(wrongPassword)).toBe('INVALID_CREDENTIALS');
    });

    it('blocks the account after 5 failures, even with the right password', async () => {
      const { user } = await register();
      for (let i = 0; i < 5; i++) {
        await gql(app, LOGIN, {
          input: { email: user.email, password: 'wrong guess' },
        });
      }
      const res = await gql(app, LOGIN, {
        input: { email: user.email, password: PASSWORD },
      });
      expect(errorCode(res)).toBe('TOO_MANY_ATTEMPTS');
    });
  });

  describe('access tokens', () => {
    it('protects resolvers by default', async () => {
      expect(errorCode(await gql(app, ME))).toBe('UNAUTHENTICATED');
      expect(errorCode(await gql(app, ME, {}, 'not-a-jwt'))).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('rejects a token whose payload was tampered with', async () => {
      const { accessToken } = await register();
      const [header, payload, signature] = accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
      const forged = Buffer.from(
        JSON.stringify({ ...claims, sub: randomUUID() }),
      ).toString('base64url');

      const res = await gql(app, ME, {}, `${header}.${forged}.${signature}`);
      expect(errorCode(res)).toBe('UNAUTHENTICATED');
    });
  });

  describe('refresh token rotation', () => {
    it('exchanges a refresh token for a new pair', async () => {
      const auth = await register();
      const res = await refresh(auth.refreshToken);

      const next = res.data!.refreshSession;
      expect(next.refreshToken).not.toBe(auth.refreshToken);
      const me = await gql(app, ME, {}, next.accessToken);
      expect(me.errors).toBeUndefined();
    });

    it('recovers when the rotation response is lost (retry within grace)', async () => {
      const auth = await register();
      await refresh(auth.refreshToken); // response "lost": client never stores it

      const retry = await refresh(auth.refreshToken);
      expect(retry.errors).toBeUndefined();

      // The recovered token keeps working, and the session is intact.
      const next = await refresh(retry.data!.refreshSession.refreshToken);
      expect(next.errors).toBeUndefined();
    });

    it('revokes the whole session when a spent token is replayed', async () => {
      const auth = await register();
      const legit = (await refresh(auth.refreshToken)).data!.refreshSession;
      const legitNext = (await refresh(legit.refreshToken)).data!
        .refreshSession;

      // Attacker replays the original token after the successor was used.
      const replay = await refresh(auth.refreshToken);
      expect(errorCode(replay)).toBe('UNAUTHENTICATED');

      const session = await sessionOf(auth.refreshToken);
      expect(session.revokedReason).toBe('REFRESH_TOKEN_REUSE');
      // Everything issued to the session is dead, immediately.
      expect(errorCode(await refresh(legitNext.refreshToken))).toBe(
        'UNAUTHENTICATED',
      );
      expect(errorCode(await gql(app, ME, {}, legitNext.accessToken))).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('treats a retry after the grace window as reuse', async () => {
      const auth = await register();
      await refresh(auth.refreshToken);
      const session = await sessionOf(auth.refreshToken);
      await prisma.$executeRaw`
        UPDATE refresh_tokens SET rotated_at = now() - interval '5 minutes'
        WHERE session_id = ${session.id}::uuid AND rotated_at IS NOT NULL`;

      expect(errorCode(await refresh(auth.refreshToken))).toBe(
        'UNAUTHENTICATED',
      );
      expect((await sessionOf(auth.refreshToken)).revokedReason).toBe(
        'REFRESH_TOKEN_REUSE',
      );
    });

    it('serializes concurrent refreshes: one live token, session intact', async () => {
      const auth = await register();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => refresh(auth.refreshToken)),
      );

      expect(results.every((r) => !r.errors)).toBe(true);
      const session = await sessionOf(auth.refreshToken);
      expect(session.revokedAt).toBeNull();
      const live = await prisma.refreshToken.count({
        where: { sessionId: session.id, rotatedAt: null, revokedAt: null },
      });
      expect(live).toBe(1);
    });

    it('rejects unknown tokens without side effects', async () => {
      expect(errorCode(await refresh('made-up-token'))).toBe('UNAUTHENTICATED');
      expect(errorCode(await refresh(''))).toBe('UNAUTHENTICATED');
    });
  });

  describe('sessions', () => {
    it('logout kills the access token immediately, not after it expires', async () => {
      const auth = await register();
      const res = await gql(app, 'mutation { logout }', {}, auth.accessToken);
      expect(res.errors).toBeUndefined();

      expect(errorCode(await gql(app, ME, {}, auth.accessToken))).toBe(
        'UNAUTHENTICATED',
      );
      expect(errorCode(await refresh(auth.refreshToken))).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('lists devices and signs out another one', async () => {
      const phone = await register(uniqueEmail(), 'iPhone');
      const tablet = (
        await gql<{ login: AuthData }>(app, LOGIN, {
          input: {
            email: phone.user.email,
            password: PASSWORD,
            deviceName: 'iPad',
          },
        })
      ).data!.login;

      const list = await gql<{
        sessions: { id: string; deviceName: string; current: boolean }[];
      }>(app, '{ sessions { id deviceName current } }', {}, phone.accessToken);
      const sessions = list.data!.sessions;
      expect(sessions.map((s) => s.deviceName).sort()).toEqual([
        'iPad',
        'iPhone',
      ]);
      const ipad = sessions.find((s) => s.deviceName === 'iPad')!;
      expect(ipad.current).toBe(false);

      const revoke = await gql(
        app,
        'mutation Revoke($id: ID!) { revokeSession(id: $id) }',
        { id: ipad.id },
        phone.accessToken,
      );
      expect(revoke.errors).toBeUndefined();
      expect(errorCode(await gql(app, ME, {}, tablet.accessToken))).toBe(
        'UNAUTHENTICATED',
      );
      expect(
        (await gql(app, ME, {}, phone.accessToken)).errors,
      ).toBeUndefined();
    });

    it("can't touch another user's session, and can't tell it exists", async () => {
      const alice = await register();
      const bob = await register();
      const bobSession = await sessionOf(bob.refreshToken);
      const REVOKE = 'mutation Revoke($id: ID!) { revokeSession(id: $id) }';

      const foreign = await gql(
        app,
        REVOKE,
        { id: bobSession.id },
        alice.accessToken,
      );
      const missing = await gql(
        app,
        REVOKE,
        { id: randomUUID() },
        alice.accessToken,
      );
      const garbage = await gql(
        app,
        REVOKE,
        { id: 'not-a-uuid' },
        alice.accessToken,
      );

      expect(foreign.errors).toEqual(missing.errors);
      expect(errorCode(foreign)).toBe('NOT_FOUND');
      expect(errorCode(garbage)).toBe('NOT_FOUND');
      expect((await gql(app, ME, {}, bob.accessToken)).errors).toBeUndefined();
    });
  });

  describe('database invariants', () => {
    it('refuses a second live refresh token for one session', async () => {
      const auth = await register();
      const session = await sessionOf(auth.refreshToken);

      await expect(
        prisma.refreshToken.create({
          data: {
            sessionId: session.id,
            tokenHash: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toThrow(/Unique constraint/);
    });

    it('refuses a non-lowercase email even if app code is bypassed', async () => {
      await expect(
        prisma.$executeRaw`INSERT INTO users (id, email, password_hash, updated_at)
          VALUES (${randomUUID()}::uuid, ${'Upper@Example.com'}, 'x', now())`,
      ).rejects.toThrow(/users_email_lowercase/);
    });
  });
});
