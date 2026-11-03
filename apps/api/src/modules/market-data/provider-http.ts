import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ProviderError, type ProviderName } from './market-data.types';

export type ProviderHttpOptions = {
  name: ProviderName;
  baseUrl: string;
  /** Our own ceiling, below the provider's published limit. */
  requestsPerMinute: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Query parameters added to every request (e.g. an API key). Never logged. */
  defaultQuery?: Record<string, string>;
};

export type ProviderHealth = {
  name: ProviderName;
  status: 'UP' | 'DEGRADED' | 'DOWN';
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  rateLimitedUntil: Date | null;
};

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;

// One instance per provider. Every outbound call goes through here, which is
// what keeps a provider outage from turning into a request storm:
//   - a per-minute budget shared through Redis (all API instances combined),
//   - a cooldown honoring Retry-After after a 429, also shared through Redis,
//   - a circuit breaker after repeated failures (per instance),
//   - one retry for network errors/5xx only, never for 4xx/429.
export class ProviderHttp {
  private readonly logger: Logger;
  private readonly health: ProviderHealth;
  private circuitOpenUntil = 0;

  constructor(
    private readonly options: ProviderHttpOptions,
    private readonly redis: Redis,
  ) {
    this.logger = new Logger(`Provider:${options.name}`);
    this.health = {
      name: options.name,
      status: 'UP',
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      consecutiveFailures: 0,
      lastLatencyMs: null,
      rateLimitedUntil: null,
    };
  }

  get name(): ProviderName {
    return this.options.name;
  }

  snapshot(): ProviderHealth {
    return { ...this.health };
  }

  async getJson<T>(
    path: string,
    query: Record<string, string> = {},
  ): Promise<T> {
    await this.admit();
    try {
      return await this.request<T>(path, query, 1);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== 'UNAVAILABLE')
        throw error;
      await sleep(300 + Math.random() * 400);
      return this.request<T>(path, query, 2);
    }
  }

  private async admit(): Promise<void> {
    const now = Date.now();
    if (now < this.circuitOpenUntil) {
      throw new ProviderError(
        this.name,
        'CIRCUIT_OPEN',
        'circuit open after repeated failures',
      );
    }
    const cooldown = await this.redis
      .pttl(`md:provider:${this.name}:cooldown`)
      .catch(() => -2);
    if (cooldown > 0) {
      this.health.rateLimitedUntil = new Date(now + cooldown);
      throw new ProviderError(
        this.name,
        'RATE_LIMITED',
        `cooling down for ${cooldown}ms`,
      );
    }
    // ponytail: fixed one-minute window; allows a 2x burst at window edges. A
    // sliding window or token bucket if a provider ever punishes bursts.
    const windowKey = `md:provider:${this.name}:budget:${Math.floor(now / 60_000)}`;
    const used = await this.redis
      .multi()
      .incr(windowKey)
      .expire(windowKey, 120)
      .exec()
      .then((replies) => Number(replies?.[0]?.[1] ?? 0))
      // Redis down: fail open. The breaker and 429 handling still protect us.
      .catch(() => 0);
    if (used > this.options.requestsPerMinute) {
      throw new ProviderError(
        this.name,
        'BUDGET_EXHAUSTED',
        'local per-minute budget used up',
      );
    }
  }

  private async request<T>(
    path: string,
    query: Record<string, string>,
    attempt: number,
  ): Promise<T> {
    const url = new URL(this.options.baseUrl.replace(/\/$/, '') + path);
    for (const [key, value] of Object.entries({
      ...this.options.defaultQuery,
      ...query,
    })) {
      url.searchParams.set(key, value);
    }
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', ...this.options.headers },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'network error';
      throw this.fail(
        'UNAVAILABLE',
        `${reason} on ${path} (attempt ${attempt})`,
      );
    }
    const latencyMs = Math.round(performance.now() - started);
    this.health.lastLatencyMs = latencyMs;

    if (response.status === 429 || response.status === 418) {
      // 418 = Binance's "you ignored our 429s" IP ban.
      const retryAfterMs =
        (Number(response.headers.get('retry-after')) || 0) * 1000 ||
        DEFAULT_COOLDOWN_MS;
      await this.redis
        .set(`md:provider:${this.name}:cooldown`, '1', 'PX', retryAfterMs)
        .catch(() => undefined);
      this.health.rateLimitedUntil = new Date(Date.now() + retryAfterMs);
      this.logger.warn(
        `rate limited (${response.status}), cooling down ${retryAfterMs}ms`,
      );
      throw this.fail('RATE_LIMITED', `HTTP ${response.status}`);
    }
    if (response.status >= 500) {
      throw this.fail(
        'UNAVAILABLE',
        `HTTP ${response.status} on ${path} (attempt ${attempt})`,
      );
    }
    if (!response.ok) {
      throw this.fail('BAD_RESPONSE', `HTTP ${response.status} on ${path}`);
    }

    let body: T;
    try {
      body = (await response.json()) as T;
    } catch {
      throw this.fail('BAD_RESPONSE', `invalid JSON on ${path}`);
    }
    this.health.consecutiveFailures = 0;
    this.health.lastSuccessAt = new Date();
    this.health.status = 'UP';
    this.logger.debug(`${path} ${response.status} in ${latencyMs}ms`);
    return body;
  }

  /** Normalizers call this when a 200 response has the wrong shape. */
  badResponse(message: string): ProviderError {
    return this.fail('BAD_RESPONSE', message);
  }

  private fail(kind: ProviderError['kind'], message: string): ProviderError {
    this.health.consecutiveFailures++;
    this.health.lastFailureAt = new Date();
    this.health.lastError = `${kind}: ${message}`;
    this.health.status =
      this.health.consecutiveFailures >= CIRCUIT_THRESHOLD
        ? 'DOWN'
        : 'DEGRADED';
    // At/over the threshold every failure (including the half-open trial
    // after the window) re-opens the circuit.
    if (this.health.consecutiveFailures >= CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      this.logger.warn(
        `circuit open for ${CIRCUIT_OPEN_MS}ms after ${this.health.consecutiveFailures} consecutive failures`,
      );
    }
    return new ProviderError(this.name, kind, message);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
