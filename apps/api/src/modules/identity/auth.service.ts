import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma, type User } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError } from '../../shared/errors/app-error';
import { AccountsService } from '../accounts/accounts.service';
import { Metrics } from '../../infrastructure/metrics/metrics';
import { AccessTokens } from './access-tokens';
import { loginSchema, parseInput, registerSchema } from './inputs';
import { LoginThrottle } from './login-throttle';
import { hashPassword, verifyPassword } from './password';
import { decideRefresh } from './refresh-rotation';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // idle timeout
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // absolute lifetime
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tx = Prisma.TransactionClient;

export type Viewer = { userId: string; sessionId: string };

export type AuthResult = {
  user: User;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

type RefreshOutcome =
  | {
      ok: true;
      user: User;
      sessionId: string;
      refreshToken: string;
      refreshTokenExpiresAt: Date;
    }
  | { ok: false };

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function sessionExpired(): AppError {
  return new AppError(
    'UNAUTHENTICATED',
    'Session expired. Please sign in again.',
  );
}

@Injectable()
export class AuthService {
  // Login runs a real argon2 verify even for unknown emails, so response time
  // doesn't reveal whether an account exists.
  private readonly dummyHash = hashPassword(randomUUID());

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokens: AccessTokens,
    private readonly throttle: LoginThrottle,
    private readonly accounts: AccountsService,
    private readonly metrics: Metrics,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  async register(input: unknown): Promise<AuthResult> {
    const { email, password, deviceName } = parseInput(registerSchema, input);
    const passwordHash = await hashPassword(password);

    try {
      // User, first session and checking account commit together: no user
      // without a way in, and no user without somewhere to hold money.
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email, passwordHash } });
        await this.accounts.openCustomerAccount(tx, user.id, 'BRL');
        return this.startSession(tx, user, deviceName);
      });
    } catch (error) {
      // The unique index is the real check. A "SELECT then INSERT" pre-check
      // would race: two concurrent sign-ups could both pass it.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError(
          'EMAIL_TAKEN',
          'An account with this email already exists.',
        );
      }
      throw error;
    }
  }

  async login(input: unknown): Promise<AuthResult> {
    const { email, password, deviceName } = parseInput(loginSchema, input);
    await this.throttle.assertAllowed(email).catch((error: unknown) => {
      this.metrics.authFailures.inc({ reason: 'throttled' });
      throw error;
    });

    const user = await this.prisma.user.findUnique({ where: { email } });
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? (await this.dummyHash),
    );

    if (!user || !valid) {
      await this.throttle.recordFailure(email);
      this.metrics.authFailures.inc({ reason: 'invalid_credentials' });
      this.logger.info({ userId: user?.id ?? null }, 'login failed');
      // Same error for "no such user" and "wrong password".
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    await this.throttle.reset(email);
    return this.prisma.$transaction((tx) =>
      this.startSession(tx, user, deviceName),
    );
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    if (refreshToken.length === 0 || refreshToken.length > 200) {
      throw sessionExpired();
    }
    const tokenHash = sha256(refreshToken);

    const outcome = await this.prisma.$transaction(
      (tx) => this.rotate(tx, tokenHash),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (!outcome.ok) throw sessionExpired();

    // Signing happens after commit. If the response is lost from here on,
    // the client retries with the old token and lands in the grace window.
    const access = await this.accessTokens.sign({
      userId: outcome.user.id,
      sessionId: outcome.sessionId,
    });
    return {
      user: outcome.user,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: outcome.refreshToken,
      refreshTokenExpiresAt: outcome.refreshTokenExpiresAt,
    };
  }

  async logout(viewer: Viewer): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.revokeSession(tx, viewer.sessionId, 'LOGOUT'),
    );
  }

  async listSessions(viewer: Viewer) {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId: viewer.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((session) => ({
      ...session,
      current: session.id === viewer.sessionId,
    }));
  }

  // Ownership is part of the WHERE clause, not a separate check: another
  // user's session id behaves exactly like a non-existent one.
  async revokeOwnSession(viewer: Viewer, sessionId: string): Promise<void> {
    const revoked =
      UUID_PATTERN.test(sessionId) &&
      (await this.prisma.$transaction(async (tx) => {
        const owned = await tx.session.findFirst({
          where: { id: sessionId, userId: viewer.userId, revokedAt: null },
          select: { id: true },
        });
        if (!owned) return false;
        await this.revokeSession(tx, owned.id, 'USER_REVOKED');
        return true;
      }));

    if (!revoked) throw new AppError('NOT_FOUND', 'Session not found.');
  }

  // Called on every authenticated request. Checking the session (one primary
  // key lookup) makes logout and "revoke device" take effect immediately,
  // instead of when the 15-minute access token happens to expire.
  async authenticate(
    authorization: string | undefined,
  ): Promise<Viewer | null> {
    const match = /^Bearer (\S+)$/.exec(authorization ?? '');
    if (!match?.[1]) return null;

    const claims = await this.accessTokens.verify(match[1]);
    if (!claims || !UUID_PATTERN.test(claims.sessionId)) return null;

    const session = await this.prisma.session.findFirst({
      where: {
        id: claims.sessionId,
        userId: claims.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return session ? claims : null;
  }

  findUser(userId: string) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  }

  private async rotate(tx: Tx, tokenHash: string): Promise<RefreshOutcome> {
    const found = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: { sessionId: true },
    });
    if (!found) {
      this.metrics.refreshAttempts.inc({ outcome: 'unknown_token' });
      return { ok: false };
    }

    // Serialize every refresh of this session. Prisma has no row-lock API,
    // hence raw SQL (ADR 0002).
    await tx.$queryRaw`SELECT 1 FROM sessions WHERE id = ${found.sessionId}::uuid FOR UPDATE`;

    // Re-read AFTER taking the lock. Under READ COMMITTED each statement sees
    // what was committed before it started, so a rotation that committed
    // while we waited is visible here. The read above may be stale.
    const token = await tx.refreshToken.findUniqueOrThrow({
      where: { tokenHash },
      include: { session: { include: { user: true } }, replacedBy: true },
    });
    const now = new Date();
    const decision = decideRefresh(token, token.session, now);
    this.metrics.refreshAttempts.inc({ outcome: decision });

    switch (decision) {
      case 'reject':
        return { ok: false };

      case 'revoke-session':
        this.logger.warn(
          { userId: token.session.userId, sessionId: token.sessionId },
          'refresh token reuse detected, revoking session',
        );
        await this.revokeSession(tx, token.sessionId, 'REFRESH_TOKEN_REUSE');
        // Return instead of throwing: a throw would roll back the revocation.
        return { ok: false };

      case 'rotate':
        // Order matters: the partial unique index allows one live token per
        // session, so the old one must stop being live before the insert.
        await tx.refreshToken.update({
          where: { id: token.id },
          data: { rotatedAt: now },
        });
        break;

      case 'reissue':
        // The successor never reached the client. Kill it and issue another.
        await tx.refreshToken.update({
          where: { id: token.replacedById! },
          data: { revokedAt: now },
        });
        break;
    }

    const next = await this.issueRefreshToken(tx, token.session, now);
    await tx.refreshToken.update({
      where: { id: token.id },
      data: { replacedById: next.id },
    });
    await tx.session.update({
      where: { id: token.sessionId },
      data: { lastRefreshedAt: now },
    });

    return {
      ok: true,
      user: token.session.user,
      sessionId: token.sessionId,
      refreshToken: next.token,
      refreshTokenExpiresAt: next.expiresAt,
    };
  }

  private async startSession(
    tx: Tx,
    user: User,
    deviceName: string | undefined,
  ): Promise<AuthResult> {
    const now = new Date();
    const session = await tx.session.create({
      data: {
        userId: user.id,
        deviceName,
        expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS),
      },
    });
    const refresh = await this.issueRefreshToken(tx, session, now);
    const access = await this.accessTokens.sign(
      { userId: user.id, sessionId: session.id },
      now,
    );

    return {
      user,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  private async issueRefreshToken(
    tx: Tx,
    session: { id: string; expiresAt: Date },
    now: Date,
  ) {
    // 256 bits of randomness: unguessable, so a fast hash (SHA-256) is enough
    // for storage. Passwords need argon2 because humans pick guessable ones.
    const token = randomBytes(32).toString('base64url');
    // Rotation never extends a session past its absolute lifetime.
    const expiresAt = new Date(
      Math.min(
        now.getTime() + REFRESH_TOKEN_TTL_MS,
        session.expiresAt.getTime(),
      ),
    );
    const row = await tx.refreshToken.create({
      data: { sessionId: session.id, tokenHash: sha256(token), expiresAt },
      select: { id: true },
    });
    return { id: row.id, token, expiresAt };
  }

  private async revokeSession(
    tx: Tx,
    sessionId: string,
    reason: 'LOGOUT' | 'USER_REVOKED' | 'REFRESH_TOKEN_REUSE',
  ) {
    const now = new Date();
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { sessionId, rotatedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
