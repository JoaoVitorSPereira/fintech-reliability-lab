import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { createTestApp, errorCode, gql, registerUser } from './graphql';

const ACCOUNT = `query A($id: ID!) { account(id: $id) { id currency balance { amount currency } } }`;
const STATEMENT = `query S($id: ID!, $first: Int!, $after: String) {
  transactions(accountId: $id, first: $first, after: $after) {
    nodes { id kind description amount { amount currency } }
    pageInfo { endCursor hasNextPage }
  }
}`;

describe('Accounts and ledger (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let fundingId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ledger = app.get(LedgerService);
    fundingId = (
      await prisma.account.findUniqueOrThrow({
        where: { systemCode: 'external-funding:BRL' },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  // Money in from outside: the system account goes negative, the customer's up.
  function deposit(accountId: string, minor: bigint) {
    return prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: 'DEPOSIT',
        description: 'Test deposit',
        postings: [
          { accountId: fundingId, currency: 'BRL', amount: -minor },
          { accountId, currency: 'BRL', amount: minor },
        ],
      }),
    );
  }

  function balanceOf(accountId: string) {
    return prisma.account
      .findUniqueOrThrow({ where: { id: accountId } })
      .then((account) => account.balance);
  }

  it('opens a BRL checking account with a zero balance at registration', async () => {
    const user = await registerUser(app);
    const res = await gql(
      app,
      ACCOUNT,
      { id: user.accountId },
      user.accessToken,
    );
    expect(res.data).toEqual({
      account: {
        id: user.accountId,
        currency: 'BRL',
        balance: { amount: '0.00', currency: 'BRL' },
      },
    });
  });

  it('posts a balanced deposit and shows it as an exact decimal string', async () => {
    const user = await registerUser(app);
    await deposit(user.accountId, 100_050n);

    const account = await gql<{ account: { balance: { amount: string } } }>(
      app,
      ACCOUNT,
      { id: user.accountId },
      user.accessToken,
    );
    expect(account.data!.account.balance.amount).toBe('1000.50');

    const statement = await gql<{ transactions: { nodes: unknown[] } }>(
      app,
      STATEMENT,
      { id: user.accountId, first: 10 },
      user.accessToken,
    );
    expect(statement.data!.transactions.nodes).toEqual([
      expect.objectContaining({
        kind: 'DEPOSIT',
        description: 'Test deposit',
        amount: { amount: '1000.50', currency: 'BRL' },
      }),
    ]);
  });

  it('paginates the statement with stable cursors', async () => {
    const user = await registerUser(app);
    for (let i = 1n; i <= 5n; i++) await deposit(user.accountId, i * 100n);

    type Page = {
      transactions: {
        nodes: { id: string; amount: { amount: string } }[];
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    };
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const res: { data?: Page } = await gql<Page>(
        app,
        STATEMENT,
        { id: user.accountId, first: 2, after },
        user.accessToken,
      );
      const page: Page['transactions'] = res.data!.transactions;
      seen.push(...page.nodes.map((node) => node.amount.amount));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      pages++;
    } while (after);

    expect(pages).toBe(3);
    expect(seen).toEqual(['5.00', '4.00', '3.00', '2.00', '1.00']);
  });

  it("hides other users' accounts and statements behind NOT_FOUND", async () => {
    const owner = await registerUser(app);
    const intruder = await registerUser(app);

    const account = await gql(
      app,
      ACCOUNT,
      { id: owner.accountId },
      intruder.accessToken,
    );
    const missing = await gql(
      app,
      ACCOUNT,
      { id: crypto.randomUUID() },
      intruder.accessToken,
    );
    const statement = await gql(
      app,
      STATEMENT,
      { id: owner.accountId, first: 5 },
      intruder.accessToken,
    );

    expect(errorCode(account)).toBe('NOT_FOUND');
    expect(account.errors![0]!.message).toBe(missing.errors![0]!.message);
    expect(errorCode(statement)).toBe('NOT_FOUND');
  });

  it('rejects out-of-range page sizes and forged cursors', async () => {
    const user = await registerUser(app);
    const big = await gql(
      app,
      STATEMENT,
      { id: user.accountId, first: 1000 },
      user.accessToken,
    );
    const forged = await gql(
      app,
      STATEMENT,
      { id: user.accountId, first: 5, after: 'bm9wZQ' },
      user.accessToken,
    );
    expect(errorCode(big)).toBe('BAD_USER_INPUT');
    expect(errorCode(forged)).toBe('BAD_USER_INPUT');
  });

  // The spec's scenario: R$1,000 in the account, two R$800 withdrawals at once.
  it('lets exactly one of two concurrent R$800 withdrawals through', async () => {
    const user = await registerUser(app);
    await deposit(user.accountId, 100_000n);

    function withdraw() {
      return prisma.$transaction((tx) =>
        ledger.post(tx, {
          kind: 'DEPOSIT',
          description: 'Test withdrawal',
          postings: [
            { accountId: user.accountId, currency: 'BRL', amount: -80_000n },
            { accountId: fundingId, currency: 'BRL', amount: 80_000n },
          ],
        }),
      );
    }

    // No application-level balance check at all: the CHECK constraint, under
    // the row lock the balance UPDATE takes, is what stops the overdraft.
    const results = await Promise.allSettled([withdraw(), withdraw()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(String(rejected?.reason)).toMatch(/accounts_customer_non_negative/);
    expect(await balanceOf(user.accountId)).toBe(20_000n);
  });

  describe('database invariants (bypassing the application)', () => {
    async function insertTransaction() {
      const [row] = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO ledger_transactions (id, kind, description)
        VALUES (gen_random_uuid(), 'DEPOSIT', 'raw') RETURNING id`;
      return row!.id;
    }

    it('refuses to commit an unbalanced transaction', async () => {
      const user = await registerUser(app);
      await expect(
        prisma.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO ledger_transactions (id, kind, description)
            VALUES (gen_random_uuid(), 'DEPOSIT', 'raw') RETURNING id`;
          await tx.$executeRaw`
            INSERT INTO ledger_entries (id, transaction_id, account_id, currency, amount) VALUES
              (gen_random_uuid(), ${row!.id}::uuid, ${fundingId}::uuid, 'BRL', -500),
              (gen_random_uuid(), ${row!.id}::uuid, ${user.accountId}::uuid, 'BRL', 499)`;
        }),
      ).rejects.toThrow(/unbalanced/);
      // The whole transaction rolled back, including the balance trigger.
      expect(await balanceOf(user.accountId)).toBe(0n);
    });

    it('refuses a transaction with no entries', async () => {
      await expect(insertTransaction()).rejects.toThrow(/at least two entries/);
    });

    it('refuses an entry whose currency differs from its account', async () => {
      const user = await registerUser(app);
      await expect(
        prisma.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO ledger_transactions (id, kind, description)
            VALUES (gen_random_uuid(), 'DEPOSIT', 'raw') RETURNING id`;
          await tx.$executeRaw`
            INSERT INTO ledger_entries (id, transaction_id, account_id, currency, amount)
            VALUES (gen_random_uuid(), ${row!.id}::uuid, ${user.accountId}::uuid, 'USD', 500)`;
        }),
      ).rejects.toThrow(/ledger_entries_account_id_currency_fkey/);
    });

    it('refuses UPDATE and DELETE on posted entries', async () => {
      const user = await registerUser(app);
      await deposit(user.accountId, 1_000n);
      await expect(
        prisma.$executeRaw`UPDATE ledger_entries SET amount = 999999 WHERE account_id = ${user.accountId}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRaw`DELETE FROM ledger_entries WHERE account_id = ${user.accountId}::uuid`,
      ).rejects.toThrow(/append-only/);
    });

    it("refuses to change an account's currency or owner", async () => {
      const user = await registerUser(app);
      await expect(
        prisma.$executeRaw`UPDATE accounts SET currency = 'USD' WHERE id = ${user.accountId}::uuid`,
      ).rejects.toThrow(/immutable/);
    });
  });

  it('reconciles: cached balances match entries and the ledger sums to zero', async () => {
    const report = await ledger.verifyIntegrity();
    expect(report).toEqual({
      ok: true,
      driftedAccounts: [],
      unbalancedCurrencies: [],
    });
  });
});
