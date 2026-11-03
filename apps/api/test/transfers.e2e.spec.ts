import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import {
  createTestApp,
  errorCode,
  gql,
  registerUser,
  type TestUser,
} from './graphql';

const TRANSFER = `mutation T($input: CreateTransferInput!) {
  createTransfer(input: $input) {
    replayed
    transfer { id kind fromAccountId toAccountId amount { amount currency } description }
  }
}`;
const DEPOSIT = `mutation D($input: SimulateDepositInput!) {
  simulateDeposit(input: $input) { replayed transfer { id kind amount { amount } } }
}`;

type TransferData = {
  createTransfer: {
    replayed: boolean;
    transfer: { id: string; amount: { amount: string } };
  };
};

function key() {
  return crypto.randomUUID();
}

describe('Transfers (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function fund(user: TestUser, amount: string) {
    const res = await gql(
      app,
      DEPOSIT,
      {
        input: { accountId: user.accountId, amount, idempotencyKey: key() },
      },
      user.accessToken,
    );
    expect(res.errors).toBeUndefined();
  }

  function transfer(
    from: TestUser,
    to: TestUser,
    amount: string,
    idempotencyKey = key(),
  ) {
    return gql<TransferData>(
      app,
      TRANSFER,
      {
        input: {
          fromAccountId: from.accountId,
          toAccountId: to.accountId,
          amount,
          idempotencyKey,
        },
      },
      from.accessToken,
    );
  }

  async function balance(user: TestUser) {
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: user.accountId },
    });
    return account.balance;
  }

  it('moves money between two users and records both statement lines', async () => {
    const [ana, bruno] = [await registerUser(app), await registerUser(app)];
    await fund(ana, '1000');

    const res = await transfer(ana, bruno, '300.25');
    expect(res.errors).toBeUndefined();
    expect(res.data!.createTransfer).toMatchObject({
      replayed: false,
      transfer: {
        kind: 'TRANSFER',
        amount: { amount: '300.25', currency: 'BRL' },
      },
    });
    expect(await balance(ana)).toBe(69_975n);
    expect(await balance(bruno)).toBe(30_025n);
  });

  it('labels deposits as simulated and caps them', async () => {
    const user = await registerUser(app);
    const ok = await gql<{ simulateDeposit: { transfer: { kind: string } } }>(
      app,
      DEPOSIT,
      {
        input: {
          accountId: user.accountId,
          amount: '50000',
          idempotencyKey: key(),
        },
      },
      user.accessToken,
    );
    expect(ok.data!.simulateDeposit.transfer.kind).toBe('SIMULATED_DEPOSIT');

    const tooMuch = await gql(
      app,
      DEPOSIT,
      {
        input: {
          accountId: user.accountId,
          amount: '50000.01',
          idempotencyKey: key(),
        },
      },
      user.accessToken,
    );
    expect(errorCode(tooMuch)).toBe('BAD_USER_INPUT');
  });

  describe('idempotency', () => {
    it('returns the original result when a lost response is retried', async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      await fund(ana, '100');
      const k = key();

      const first = await transfer(ana, bruno, '40', k);
      const retry = await transfer(ana, bruno, '40', k);

      expect(retry.data!.createTransfer.replayed).toBe(true);
      expect(retry.data!.createTransfer.transfer.id).toBe(
        first.data!.createTransfer.transfer.id,
      );
      expect(await balance(ana)).toBe(6_000n);
    });

    it('moves money once when 5 identical requests race', async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      await fund(ana, '100');
      const k = key();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => transfer(ana, bruno, '60', k)),
      );

      expect(results.map(errorCode)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      const ids = new Set(
        results.map((r) => r.data!.createTransfer.transfer.id),
      );
      expect(ids.size).toBe(1);
      expect(
        results.filter((r) => !r.data!.createTransfer.replayed),
      ).toHaveLength(1);
      expect(await balance(ana)).toBe(4_000n);
      expect(await balance(bruno)).toBe(6_000n);
    });

    it('rejects the same key with a different amount', async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      await fund(ana, '100');
      const k = key();
      await transfer(ana, bruno, '10', k);
      const changed = await transfer(ana, bruno, '11', k);
      expect(errorCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balance(ana)).toBe(9_000n);
    });

    it('scopes keys per user', async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      await fund(ana, '10');
      await fund(bruno, '10');
      const k = key();
      expect((await transfer(ana, bruno, '1', k)).errors).toBeUndefined();
      expect(
        (await transfer(bruno, ana, '1', k)).data!.createTransfer.replayed,
      ).toBe(false);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two concurrent R$800 transfers out of R$1,000 through', async () => {
      const [ana, bruno, carla] = [
        await registerUser(app),
        await registerUser(app),
        await registerUser(app),
      ];
      await fund(ana, '1000');

      const results = await Promise.all([
        transfer(ana, bruno, '800'),
        transfer(ana, carla, '800'),
      ]);

      expect(
        results.filter((r) => errorCode(r) === 'INSUFFICIENT_FUNDS'),
      ).toHaveLength(1);
      expect(results.filter((r) => !r.errors)).toHaveLength(1);
      expect(await balance(ana)).toBe(20_000n);
    });

    it('never deadlocks on opposing transfers (A->B and B->A at once)', async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      await fund(ana, '1000');
      await fund(bruno, '1000');

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0 ? transfer(ana, bruno, '1') : transfer(bruno, ana, '1'),
        ),
      );

      expect(results.map(errorCode).filter(Boolean)).toEqual([]);
      expect((await balance(ana)) + (await balance(bruno))).toBe(200_000n);
    });
  });

  describe('validation and authorization', () => {
    it("can't spend from someone else's account", async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      await fund(bruno, '100');
      const res = await gql(
        app,
        TRANSFER,
        {
          input: {
            fromAccountId: bruno.accountId,
            toAccountId: ana.accountId,
            amount: '10',
            idempotencyKey: key(),
          },
        },
        ana.accessToken,
      );
      expect(errorCode(res)).toBe('NOT_FOUND');
      expect(await balance(bruno)).toBe(10_000n);
    });

    it("can't deposit into someone else's account", async () => {
      const [ana, bruno] = [await registerUser(app), await registerUser(app)];
      const res = await gql(
        app,
        DEPOSIT,
        {
          input: {
            accountId: bruno.accountId,
            amount: '10',
            idempotencyKey: key(),
          },
        },
        ana.accessToken,
      );
      expect(errorCode(res)).toBe('NOT_FOUND');
    });

    it('rejects unknown recipients and system accounts as recipients', async () => {
      const ana = await registerUser(app);
      await fund(ana, '10');
      const system = await prisma.account.findUniqueOrThrow({
        where: { systemCode: 'external-funding:BRL' },
      });
      for (const toAccountId of [crypto.randomUUID(), system.id]) {
        const res = await gql(
          app,
          TRANSFER,
          {
            input: {
              fromAccountId: ana.accountId,
              toAccountId,
              amount: '1',
              idempotencyKey: key(),
            },
          },
          ana.accessToken,
        );
        expect(errorCode(res)).toBe('NOT_FOUND');
      }
    });

    it.each(['0', '-5', '1.001', '1e3', 'abc', '10,00'])(
      'rejects amount %p',
      async (amount) => {
        const [ana, bruno] = [await registerUser(app), await registerUser(app)];
        await fund(ana, '10');
        expect(errorCode(await transfer(ana, bruno, amount))).toBe(
          'BAD_USER_INPUT',
        );
      },
    );

    it('rejects transfers to the same account and malformed keys', async () => {
      const ana = await registerUser(app);
      const same = await transfer(ana, ana, '1');
      const badKey = await gql(
        app,
        TRANSFER,
        {
          input: {
            fromAccountId: ana.accountId,
            toAccountId: crypto.randomUUID(),
            amount: '1',
            idempotencyKey: 'short',
          },
        },
        ana.accessToken,
      );
      expect(errorCode(same)).toBe('BAD_USER_INPUT');
      expect(errorCode(badKey)).toBe('BAD_USER_INPUT');
    });
  });

  it('keeps the ledger reconciled after everything above', async () => {
    expect((await app.get(LedgerService).verifyIntegrity()).ok).toBe(true);
  });
});
