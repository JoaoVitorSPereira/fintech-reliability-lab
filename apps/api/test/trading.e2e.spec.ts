import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import type { AssetCategory } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { QuoteStore } from '../src/modules/market-data/quote-store';
import { OrdersService } from '../src/modules/trading/orders.service';
import {
  createTestApp,
  errorCode,
  gql,
  registerUser,
  type TestUser,
} from './graphql';

const ORDER_FIELDS = `id status side type quantity limitPrice rejectReason isSimulated disclaimer
  reservedCash { amount } trade { price quantity notional { amount } realizedPnl { amount } priceProvider }`;
const PLACE = `mutation P($input: SimulatedOrderInput!) { createSimulatedOrder(input: $input) { replayed order { ${ORDER_FIELDS} } } }`;
const CANCEL = `mutation C($id: ID!) { cancelSimulatedOrder(orderId: $id) { replayed order { ${ORDER_FIELDS} } } }`;
const PORTFOLIO = `{ portfolio { id cashAccountId cash { amount } reservedCash { amount } totalValue { amount } totalReturnPct netDeposits { amount }
  unrealizedPnl { amount } realizedPnl { amount } valuationIsStale isSimulated
  positions { quantity reservedQuantity averagePrice costBasis { amount } marketValue { amount }
    unrealizedPnl { amount } realizedPnl { amount } asset { symbol } } } }`;

type Order = {
  id: string;
  status: string;
  rejectReason: string | null;
  isSimulated: boolean;
  disclaimer: string;
  reservedCash: { amount: string };
  trade: {
    price: string;
    notional: { amount: string };
    realizedPnl: { amount: string } | null;
    priceProvider: string;
  } | null;
};
type PlaceData = { createSimulatedOrder: { replayed: boolean; order: Order } };
type PortfolioData = {
  portfolio: {
    id: string;
    cashAccountId: string;
    cash: { amount: string };
    reservedCash: { amount: string };
    totalValue: { amount: string };
    totalReturnPct: string | null;
    netDeposits: { amount: string };
    unrealizedPnl: { amount: string };
    realizedPnl: { amount: string };
    valuationIsStale: boolean;
    isSimulated: boolean;
    positions: {
      quantity: string;
      reservedQuantity: string;
      averagePrice: string | null;
      costBasis: { amount: string };
      unrealizedPnl: { amount: string } | null;
      realizedPnl: { amount: string };
      asset: { symbol: string };
    }[];
  } | null;
};

const key = () => crypto.randomUUID();

describe('Simulated trading (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let quotes: QuoteStore;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    quotes = app.get(QuoteStore);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeAsset(category: AssetCategory = 'CRYPTO') {
    const tag = crypto.randomUUID().slice(0, 8).toUpperCase();
    return prisma.asset.create({
      data: {
        category,
        symbol: `T${tag}`,
        name: `Test ${tag}`,
        quoteCurrency: 'USD',
      },
    });
  }

  async function setPrice(
    assetId: string,
    price: string,
    opts: { ageMs?: number; marketOpen?: boolean | null } = {},
  ) {
    const at = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString();
    await quotes.write([
      {
        assetId,
        price,
        currency: 'USDT',
        change24hPct: '0',
        volume24h: null,
        marketCap: null,
        provider: 'binance-stream',
        sourceTimestamp: at,
        fetchedAt: at,
        marketOpen: opts.marketOpen ?? null,
      },
    ]);
  }

  async function trader(cash = '10000') {
    const user = await registerUser(app);
    const created = await gql<{ createPortfolio: { cashAccountId: string } }>(
      app,
      'mutation { createPortfolio { cashAccountId } }',
      {},
      user.accessToken,
    );
    const cashAccountId = created.data!.createPortfolio.cashAccountId;
    const deposit = await gql(
      app,
      `mutation D($input: SimulateDepositInput!) { simulateDeposit(input: $input) { transfer { id } } }`,
      {
        input: {
          accountId: cashAccountId,
          amount: cash,
          idempotencyKey: key(),
        },
      },
      user.accessToken,
    );
    expect(deposit.errors).toBeUndefined();
    return { ...user, cashAccountId };
  }

  function place(user: TestUser, input: Record<string, unknown>) {
    return gql<PlaceData>(
      app,
      PLACE,
      { input: { idempotencyKey: key(), ...input } },
      user.accessToken,
    );
  }

  async function portfolio(user: TestUser) {
    return (await gql<PortfolioData>(app, PORTFOLIO, {}, user.accessToken))
      .data!.portfolio!;
  }

  it('creates one portfolio per user, even under concurrent calls', async () => {
    const user = await registerUser(app);
    expect(
      (await gql<PortfolioData>(app, PORTFOLIO, {}, user.accessToken)).data!
        .portfolio,
    ).toBeNull();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        gql<{ createPortfolio: { id: string } }>(
          app,
          'mutation { createPortfolio { id } }',
          {},
          user.accessToken,
        ),
      ),
    );
    expect(new Set(results.map((r) => r.data!.createPortfolio.id)).size).toBe(
      1,
    );
  });

  it('buys at market, tracks average cost, unrealized and realized P&L', async () => {
    const user = await trader('10000');
    const asset = await makeAsset();
    await setPrice(asset.id, '100');

    const buy = await place(user, {
      assetId: asset.id,
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.5',
    });
    const order = buy.data!.createSimulatedOrder.order;
    expect(order).toMatchObject({
      status: 'FILLED',
      isSimulated: true,
      trade: {
        price: '100',
        notional: { amount: '50.00' },
        priceProvider: 'binance-stream',
      },
    });
    expect(order.disclaimer).toMatch(/No real order/);

    await setPrice(asset.id, '120');
    let p = await portfolio(user);
    expect(p.cash.amount).toBe('9950.00');
    expect(p.positions[0]).toMatchObject({
      quantity: '0.5',
      averagePrice: '100',
      costBasis: { amount: '50.00' },
      unrealizedPnl: { amount: '10.00' },
    });
    expect(p.totalValue.amount).toBe('10010.00');
    expect(p).toMatchObject({
      netDeposits: { amount: '10000.00' },
      totalReturnPct: '0.10',
    });

    const sell = await place(user, {
      assetId: asset.id,
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.25',
    });
    expect(sell.data!.createSimulatedOrder.order.trade).toMatchObject({
      notional: { amount: '30.00' },
      realizedPnl: { amount: '5.00' },
    });

    p = await portfolio(user);
    expect(p.cash.amount).toBe('9980.00');
    expect(p.realizedPnl.amount).toBe('5.00');
    expect(p.positions[0]).toMatchObject({
      quantity: '0.25',
      costBasis: { amount: '25.00' },
    });
  });

  it('rejects market orders on stale prices, closed markets, missing cash or units, and moves nothing', async () => {
    const user = await trader('100');
    const crypto = await makeAsset();
    const stock = await makeAsset('STOCK');

    await setPrice(crypto.id, '10', { ageMs: 5 * 60_000 });
    const stale = await place(user, {
      assetId: crypto.id,
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    });
    expect(stale.data!.createSimulatedOrder.order).toMatchObject({
      status: 'REJECTED',
      rejectReason: expect.stringMatching(/stale/),
    });

    await setPrice(stock.id, '10', { marketOpen: false });
    const closed = await place(user, {
      assetId: stock.id,
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    });
    expect(closed.data!.createSimulatedOrder.order.rejectReason).toBe(
      'Market is closed.',
    );

    await setPrice(crypto.id, '10');
    const tooBig = await place(user, {
      assetId: crypto.id,
      side: 'BUY',
      type: 'MARKET',
      quantity: '11',
    });
    expect(tooBig.data!.createSimulatedOrder.order.rejectReason).toMatch(
      /Insufficient cash/,
    );

    const noUnits = await place(user, {
      assetId: crypto.id,
      side: 'SELL',
      type: 'MARKET',
      quantity: '1',
    });
    expect(noUnits.data!.createSimulatedOrder.order.rejectReason).toMatch(
      /Not enough units/,
    );

    const dust = await place(user, {
      assetId: crypto.id,
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.01',
    });
    expect(dust.data!.createSimulatedOrder.order.rejectReason).toMatch(
      /minimum/,
    );

    expect((await portfolio(user)).cash.amount).toBe('100.00');
  });

  it('holds cash for a limit buy and fills it when the market reaches the limit', async () => {
    const user = await trader('1000');
    const asset = await makeAsset();
    await setPrice(asset.id, '100');

    const placed = await place(user, {
      assetId: asset.id,
      side: 'BUY',
      type: 'LIMIT',
      quantity: '2',
      limitPrice: '90',
    });
    const order = placed.data!.createSimulatedOrder.order;
    expect(order).toMatchObject({
      status: 'PENDING',
      reservedCash: { amount: '180.00' },
    });
    let p = await portfolio(user);
    expect(p).toMatchObject({
      cash: { amount: '820.00' },
      reservedCash: { amount: '180.00' },
      totalValue: { amount: '1000.00' },
    });

    await setPrice(asset.id, '85'); // better than the limit
    await app.get(OrdersService).matchPendingOrders();

    p = await portfolio(user);
    expect(p).toMatchObject({
      cash: { amount: '830.00' },
      reservedCash: { amount: '0.00' },
    }); // 180 held, 170 spent, 10 refunded
    expect(p.positions[0]).toMatchObject({ quantity: '2', averagePrice: '85' });
  });

  it('fills a marketable limit order immediately', async () => {
    const user = await trader('1000');
    const asset = await makeAsset();
    await setPrice(asset.id, '50');
    const res = await place(user, {
      assetId: asset.id,
      side: 'BUY',
      type: 'LIMIT',
      quantity: '1',
      limitPrice: '60',
    });
    expect(res.data!.createSimulatedOrder.order).toMatchObject({
      status: 'FILLED',
      trade: { price: '50' },
    });
    expect((await portfolio(user)).cash.amount).toBe('950.00');
  });

  it('cancels a pending limit buy, releases the hold, and is idempotent', async () => {
    const user = await trader('1000');
    const asset = await makeAsset();
    await setPrice(asset.id, '100');
    const order = (
      await place(user, {
        assetId: asset.id,
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '50',
      })
    ).data!.createSimulatedOrder.order;

    const first = await gql<{
      cancelSimulatedOrder: { replayed: boolean; order: Order };
    }>(app, CANCEL, { id: order.id }, user.accessToken);
    const again = await gql<{ cancelSimulatedOrder: { replayed: boolean } }>(
      app,
      CANCEL,
      { id: order.id },
      user.accessToken,
    );
    expect(first.data!.cancelSimulatedOrder).toMatchObject({
      replayed: false,
      order: { status: 'CANCELLED' },
    });
    expect(again.data!.cancelSimulatedOrder.replayed).toBe(true);
    expect(await portfolio(user)).toMatchObject({
      cash: { amount: '1000.00' },
      reservedCash: { amount: '0.00' },
    });
  });

  it('refuses to cancel a filled order', async () => {
    const user = await trader('1000');
    const asset = await makeAsset();
    await setPrice(asset.id, '10');
    const order = (
      await place(user, {
        assetId: asset.id,
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
      })
    ).data!.createSimulatedOrder.order;
    expect(
      errorCode(await gql(app, CANCEL, { id: order.id }, user.accessToken)),
    ).toBe('ORDER_NOT_PENDING');
  });

  it('reserves units for a limit sell so they cannot be sold twice', async () => {
    const user = await trader('1000');
    const asset = await makeAsset();
    await setPrice(asset.id, '10');
    await place(user, {
      assetId: asset.id,
      side: 'BUY',
      type: 'MARKET',
      quantity: '10',
    });

    const limit = await place(user, {
      assetId: asset.id,
      side: 'SELL',
      type: 'LIMIT',
      quantity: '8',
      limitPrice: '20',
    });
    expect(limit.data!.createSimulatedOrder.order.status).toBe('PENDING');
    expect((await portfolio(user)).positions[0]!.reservedQuantity).toBe('8');

    const tooMany = await place(user, {
      assetId: asset.id,
      side: 'SELL',
      type: 'MARKET',
      quantity: '3',
    });
    expect(tooMany.data!.createSimulatedOrder.order.rejectReason).toMatch(
      /Not enough units/,
    );
    const ok = await place(user, {
      assetId: asset.id,
      side: 'SELL',
      type: 'MARKET',
      quantity: '2',
    });
    expect(ok.data!.createSimulatedOrder.order.status).toBe('FILLED');
  });

  it('places one order for 5 identical concurrent requests', async () => {
    const user = await trader('1000');
    const asset = await makeAsset();
    await setPrice(asset.id, '10');
    const idempotencyKey = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        place(user, {
          assetId: asset.id,
          side: 'BUY',
          type: 'MARKET',
          quantity: '1',
          idempotencyKey,
        }),
      ),
    );
    expect(
      new Set(results.map((r) => r.data!.createSimulatedOrder.order.id)).size,
    ).toBe(1);
    expect(
      results.filter((r) => !r.data!.createSimulatedOrder.replayed),
    ).toHaveLength(1);
    expect((await portfolio(user)).cash.amount).toBe('990.00');
  });

  it('never spends the same cash twice under concurrent orders', async () => {
    const user = await trader('100');
    const asset = await makeAsset();
    await setPrice(asset.id, '60');
    const results = await Promise.all([
      place(user, {
        assetId: asset.id,
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
      }),
      place(user, {
        assetId: asset.id,
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
      }),
    ]);
    const statuses = results
      .map((r) => r.data!.createSimulatedOrder.order.status)
      .sort();
    expect(statuses).toEqual(['FILLED', 'REJECTED']);
    expect((await portfolio(user)).cash.amount).toBe('40.00');
  });

  it("keeps users out of each other's orders and portfolio cash", async () => {
    const owner = await trader('100');
    const intruder = await trader('100');
    const asset = await makeAsset();
    await setPrice(asset.id, '100');
    const order = (
      await place(owner, {
        assetId: asset.id,
        side: 'BUY',
        type: 'LIMIT',
        quantity: '0.5',
        limitPrice: '10',
      })
    ).data!.createSimulatedOrder.order;

    expect(
      errorCode(await gql(app, CANCEL, { id: order.id }, intruder.accessToken)),
    ).toBe('NOT_FOUND');
    const list = await gql<{ simulatedOrders: { nodes: { id: string }[] } }>(
      app,
      '{ simulatedOrders(first: 50) { nodes { id } } }',
      {},
      intruder.accessToken,
    );
    expect(list.data!.simulatedOrders.nodes.map((n) => n.id)).not.toContain(
      order.id,
    );

    // Paper cash can't leave through banking transfers.
    const transfer = await gql(
      app,
      `mutation T($input: CreateTransferInput!) { createTransfer(input: $input) { transfer { id } } }`,
      {
        input: {
          fromAccountId: owner.cashAccountId,
          toAccountId: intruder.cashAccountId,
          amount: '10',
          idempotencyKey: key(),
        },
      },
      owner.accessToken,
    );
    expect(errorCode(transfer)).toBe('NOT_FOUND');
  });

  it('manages a watchlist idempotently', async () => {
    const user = await registerUser(app);
    const asset = await makeAsset();
    await setPrice(asset.id, '1');
    const add = `mutation A($id: ID!) { createWatchlistItem(assetId: $id) { asset { symbol } } }`;
    await gql(app, add, { id: asset.id }, user.accessToken);
    await gql(app, add, { id: asset.id }, user.accessToken);
    const list = await gql<{
      watchlist: { asset: { id: string; quote: { price: string } } }[];
    }>(
      app,
      '{ watchlist { asset { id quote { price } } } }',
      {},
      user.accessToken,
    );
    expect(list.data!.watchlist).toEqual([
      { asset: { id: asset.id, quote: { price: '1' } } },
    ]);
    const removed = await gql<{ removeWatchlistItem: boolean }>(
      app,
      `mutation R($id: ID!) { removeWatchlistItem(assetId: $id) }`,
      { id: asset.id },
      user.accessToken,
    );
    expect(removed.data!.removeWatchlistItem).toBe(true);
  });

  it('refuses to reopen a final order at the database level', async () => {
    const user = await trader('100');
    const asset = await makeAsset();
    await setPrice(asset.id, '10');
    const order = (
      await place(user, {
        assetId: asset.id,
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
      })
    ).data!.createSimulatedOrder.order;
    await expect(
      prisma.$executeRaw`UPDATE simulated_orders SET status = 'PENDING', filled_at = NULL WHERE id = ${order.id}::uuid`,
    ).rejects.toThrow(/cannot become PENDING/);
  });

  it('keeps the ledger reconciled after all of the above', async () => {
    expect((await app.get(LedgerService).verifyIntegrity()).ok).toBe(true);
  });
});
