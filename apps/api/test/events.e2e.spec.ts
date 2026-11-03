import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { type Client, createClient } from 'graphql-ws';
import type { Redis } from 'ioredis';
import type { App } from 'supertest/types';
import WebSocket from 'ws';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { REDIS } from '../src/infrastructure/redis/redis.module';
import { EventBus } from '../src/modules/events/event-bus';
import {
  MAX_ATTEMPTS,
  OutboxPublisher,
} from '../src/modules/events/outbox-publisher.service';
import { QuoteStore } from '../src/modules/market-data/quote-store';
import {
  createTestApp,
  errorCode,
  gql,
  registerUser,
  type TestUser,
} from './graphql';

const key = () => crypto.randomUUID();
const DEPOSIT = `mutation D($input: SimulateDepositInput!) { simulateDeposit(input: $input) { transfer { id } } }`;
const TRANSFER = `mutation T($input: CreateTransferInput!) { createTransfer(input: $input) { transfer { id } } }`;

describe('Outbox and subscriptions (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let url: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as unknown as { address(): AddressInfo };
    url = `ws://127.0.0.1:${server.address().port}/graphql`;
    prisma = app.get(PrismaService);
    publisher = app.get(OutboxPublisher);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => Promise.resolve(client.dispose())));
    await app.close();
  });

  beforeEach(async () => {
    // Other suites write events without publishing them. Don't let that
    // backlog sit in front of this suite's events.
    await prisma.$executeRaw`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL AND failed_at IS NULL`;
  });

  function deposit(user: TestUser, amount = '100') {
    return gql(
      app,
      DEPOSIT,
      { input: { accountId: user.accountId, amount, idempotencyKey: key() } },
      user.accessToken,
    );
  }

  function eventsFor(aggregateId: string) {
    return prisma.outboxEvent.findMany({
      where: { aggregateId },
      orderBy: { sequence: 'asc' },
    });
  }

  function connect(token?: string): Client {
    const client = createClient({
      url,
      webSocketImpl: WebSocket,
      connectionParams: token ? { authorization: `Bearer ${token}` } : {},
      retryAttempts: 0,
      lazy: true,
    });
    clients.push(client);
    return client;
  }

  /** Subscribe and collect payloads; resolves `ready` once the server has the subscription. */
  function subscribe<T>(
    client: Client,
    query: string,
    variables: Record<string, unknown>,
  ) {
    const received: T[] = [];
    const errors: unknown[] = [];
    const unsubscribe = client.subscribe<T>(
      { query, variables },
      {
        next: (value) =>
          value.errors
            ? errors.push(value.errors)
            : received.push(value.data as T),
        error: (e) => errors.push(e),
        complete: () => undefined,
      },
    );
    return { received, errors, unsubscribe };
  }

  async function until(check: () => boolean, ms = 3_000) {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  describe('transactional outbox', () => {
    it('commits one event per customer account with the money, and none when the transfer fails', async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      await deposit(ana, '100');
      await gql(
        app,
        TRANSFER,
        {
          input: {
            fromAccountId: ana.accountId,
            toAccountId: bruno.accountId,
            amount: '30',
            idempotencyKey: key(),
          },
        },
        ana.accessToken,
      );
      const failed = await gql(
        app,
        TRANSFER,
        {
          input: {
            fromAccountId: ana.accountId,
            toAccountId: bruno.accountId,
            amount: '999',
            idempotencyKey: key(),
          },
        },
        ana.accessToken,
      );
      expect(errorCode(failed)).toBe('INSUFFICIENT_FUNDS');

      const anaEvents = await eventsFor(ana.accountId);
      expect(
        anaEvents.map((e) => [
          e.sequence,
          e.type,
          (e.payload as { balanceMinor: string }).balanceMinor,
        ]),
      ).toEqual([
        [1, 'AccountBalanceChanged', '10000'],
        [2, 'AccountBalanceChanged', '7000'],
      ]);
      expect((await eventsFor(bruno.accountId)).map((e) => e.sequence)).toEqual(
        [1],
      );
    });

    it('publishes after commit and marks events published; a restarted worker resumes the backlog', async () => {
      const user = await registerUser(app);
      await deposit(user);
      await deposit(user);
      expect(
        (await eventsFor(user.accountId)).every((e) => e.publishedAt === null),
      ).toBe(true);

      await publisher.drain(); // the "worker" starts after the events were committed
      expect(
        (await eventsFor(user.accountId)).every((e) => e.publishedAt !== null),
      ).toBe(true);
    });

    it('delivers a duplicate publish only once to subscribers (at-least-once upstream, deduped)', async () => {
      const user = await registerUser(app);
      const bus = app.get(EventBus);
      const seen: string[] = [];
      const abort = new AbortController();
      void (async () => {
        for await (const event of bus.listen<{
          id: string;
          aggregateId: string;
        }>('events:account', abort.signal)) {
          if (event.aggregateId === user.accountId) seen.push(event.id);
        }
      })().catch(() => undefined);

      await deposit(user);
      await publisher.drain();
      // Simulate a crash between "publish" and "mark published": publish again.
      await prisma.outboxEvent.updateMany({
        where: { aggregateId: user.accountId },
        data: { publishedAt: null },
      });
      await publisher.drain();
      await until(() => seen.length >= 1);
      await settle();
      abort.abort();
      expect(seen).toHaveLength(1);
    });

    it('retries with backoff, then dead-letters, when publishing keeps failing', async () => {
      const user = await registerUser(app);
      await deposit(user);
      const redis = app.get<Redis>(REDIS);
      const publish = jest
        .spyOn(redis, 'publish')
        .mockRejectedValue(new Error('redis down'));
      try {
        await publisher.drain(1);
        let [event] = await eventsFor(user.accountId);
        expect(event).toMatchObject({
          attempts: 1,
          publishedAt: null,
          failedAt: null,
          lastError: 'redis down',
        });
        expect(event!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

        await prisma.outboxEvent.update({
          where: { id: event!.id },
          data: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date() },
        });
        await publisher.drain(1);
        [event] = await eventsFor(user.accountId);
        expect(event!.failedAt).not.toBeNull();
      } finally {
        publish.mockRestore();
      }
    });

    it('keeps per-aggregate order: a failing event blocks later events of the same account only', async () => {
      const [stuck, other] = [await registerUser(app), await registerUser(app)];
      await deposit(stuck);
      await deposit(stuck);
      await deposit(other);
      const [first] = await eventsFor(stuck.accountId);
      // Event 1 of `stuck` is waiting for a retry far in the future.
      await prisma.outboxEvent.update({
        where: { id: first!.id },
        data: { attempts: 1, nextAttemptAt: new Date(Date.now() + 3_600_000) },
      });

      await publisher.drain();
      const stuckEvents = await eventsFor(stuck.accountId);
      expect(stuckEvents.map((e) => e.publishedAt !== null)).toEqual([
        false,
        false,
      ]); // #2 waits for #1
      expect((await eventsFor(other.accountId))[0]!.publishedAt).not.toBeNull();
    });
  });

  describe('GraphQL subscriptions', () => {
    const ACCOUNT_UPDATED = `subscription A($id: ID!) { accountUpdated(accountId: $id) {
      eventId sequence account { id balance { amount } } transaction { id kind amount { amount } } } }`;

    it('refuses a WebSocket connection without a valid token', async () => {
      const client = connect('not-a-token');
      const sub = subscribe(client, ACCOUNT_UPDATED, {
        id: crypto.randomUUID(),
      });
      await until(() => sub.errors.length > 0);
      expect((sub.errors[0] as { code?: number }).code).toBe(4403);
    });

    it('streams balance updates for your account, with gapless sequences', async () => {
      const user = await registerUser(app);
      const client = connect(user.accessToken);
      type Update = {
        accountUpdated: {
          sequence: number;
          account: { balance: { amount: string } };
          transaction: { kind: string; amount: { amount: string } };
        };
      };
      const sub = subscribe<Update>(client, ACCOUNT_UPDATED, {
        id: user.accountId,
      });
      await settle(); // let the subscription register

      await deposit(user, '100');
      await deposit(user, '50');
      await publisher.drain();
      await until(() => sub.received.length === 2);

      expect(sub.received.map((r) => r.accountUpdated.sequence)).toEqual([
        1, 2,
      ]);
      expect(sub.received[1]!.accountUpdated).toMatchObject({
        account: { balance: { amount: '150.00' } },
        transaction: { kind: 'DEPOSIT', amount: { amount: '50.00' } },
      });
      sub.unsubscribe();
    });

    it("refuses to subscribe to someone else's account", async () => {
      const [owner, intruder] = [
        await registerUser(app),
        await registerUser(app),
      ];
      const sub = subscribe(connect(intruder.accessToken), ACCOUNT_UPDATED, {
        id: owner.accountId,
      });
      await until(() => sub.errors.length > 0);
      expect(JSON.stringify(sub.errors)).toMatch(/NOT_FOUND/);
    });

    it('streams only the requested assets, throttled per asset', async () => {
      const user = await registerUser(app);
      const [wanted, ignored] = [crypto.randomUUID(), crypto.randomUUID()];
      type Price = {
        marketPriceUpdated: {
          assetId: string;
          price: string;
          dataQuality: string;
        };
      };
      const sub = subscribe<Price>(
        connect(user.accessToken),
        `subscription P($ids: [ID!]!) { marketPriceUpdated(assetIds: $ids) { assetId price dataQuality } }`,
        { ids: [wanted] },
      );
      await settle();

      const bus = app.get(EventBus);
      const tick = (assetId: string, price: string) =>
        bus.dispatch(
          'md:prices',
          JSON.stringify({
            assetId,
            price,
            change24hPct: '1',
            sourceTimestamp: new Date().toISOString(),
          }),
        );
      tick(ignored, '1');
      tick(wanted, '100');
      tick(wanted, '101'); // within 1s of the previous one: throttled
      await until(() => sub.received.length >= 1);
      await settle();
      expect(sub.received).toEqual([
        {
          marketPriceUpdated: {
            assetId: wanted,
            price: '100',
            dataQuality: 'LIVE',
          },
        },
      ]);
      sub.unsubscribe();
    });

    it('streams simulated order updates for your portfolio', async () => {
      const user = await registerUser(app);
      const portfolio = (
        await gql<{ createPortfolio: { id: string; cashAccountId: string } }>(
          app,
          'mutation { createPortfolio { id cashAccountId } }',
          {},
          user.accessToken,
        )
      ).data!.createPortfolio;
      await gql(
        app,
        DEPOSIT,
        {
          input: {
            accountId: portfolio.cashAccountId,
            amount: '1000',
            idempotencyKey: key(),
          },
        },
        user.accessToken,
      );
      const asset = await prisma.asset.create({
        data: {
          category: 'CRYPTO',
          symbol: `S${key().slice(0, 8)}`,
          name: 'Sub test',
          quoteCurrency: 'USD',
        },
      });
      const now = new Date().toISOString();
      await app
        .get(QuoteStore)
        .write([
          {
            assetId: asset.id,
            price: '10',
            currency: 'USDT',
            provider: 'binance-stream',
            sourceTimestamp: now,
            fetchedAt: now,
            change24hPct: null,
            volume24h: null,
            marketCap: null,
            marketOpen: null,
          },
        ]);

      type OrderUpdate = {
        simulatedOrderUpdated: {
          sequence: number;
          order: { status: string; isSimulated: boolean };
        };
      };
      const sub = subscribe<OrderUpdate>(
        connect(user.accessToken),
        `subscription O($id: ID!) { simulatedOrderUpdated(portfolioId: $id) { sequence order { status isSimulated } } }`,
        { id: portfolio.id },
      );
      await settle();
      await gql(
        app,
        `mutation P($input: SimulatedOrderInput!) { createSimulatedOrder(input: $input) { order { id } } }`,
        {
          input: {
            assetId: asset.id,
            side: 'BUY',
            type: 'MARKET',
            quantity: '1',
            idempotencyKey: key(),
          },
        },
        user.accessToken,
      );
      await publisher.drain();
      await until(() => sub.received.length === 1);
      expect(sub.received[0]!.simulatedOrderUpdated).toEqual({
        sequence: 1,
        order: { status: 'FILLED', isSimulated: true },
      });
      sub.unsubscribe();
    });

    it('lets a reconnecting client fetch the events it missed', async () => {
      const [user, intruder] = [
        await registerUser(app),
        await registerUser(app),
      ];
      for (const amount of ['1', '2', '3']) await deposit(user, amount);
      const MISSED = `query M($stream: EventStreamInput!, $after: Int!) { missedEvents(stream: $stream, afterSequence: $after) { sequence type payloadJson } }`;

      const res = await gql<{
        missedEvents: { sequence: number; payloadJson: string }[];
      }>(
        app,
        MISSED,
        { stream: { type: 'ACCOUNT', id: user.accountId }, after: 1 },
        user.accessToken,
      );
      expect(res.data!.missedEvents.map((e) => e.sequence)).toEqual([2, 3]);
      expect(JSON.parse(res.data!.missedEvents[1]!.payloadJson)).toMatchObject({
        balanceMinor: '600',
      });

      const leak = await gql(
        app,
        MISSED,
        { stream: { type: 'ACCOUNT', id: user.accountId }, after: 0 },
        intruder.accessToken,
      );
      expect(errorCode(leak)).toBe('NOT_FOUND');
    });
  });
});
