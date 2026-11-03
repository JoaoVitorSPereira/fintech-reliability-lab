import { Injectable } from '@nestjs/common';
import {
  type Asset,
  type Portfolio,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { isUniqueViolation } from '../../infrastructure/database/transaction-retry';
import { AppError } from '../../shared/errors/app-error';
import { AccountsService } from '../accounts/accounts.service';
import type { Viewer } from '../identity/auth.service';
import { QuoteStore } from '../market-data/quote-store';
import { minorToDollars } from './order-math';

type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;
const ZERO = new Decimal(0);

export type PositionValuation = {
  asset: Asset;
  quantity: Decimal;
  reservedQuantity: Decimal;
  costBasis: Decimal;
  realizedPnl: Decimal;
  averagePrice: Decimal | null;
  marketPrice: Decimal | null;
  marketValue: Decimal | null;
  unrealizedPnl: Decimal | null;
  unrealizedPnlPct: Decimal | null;
  priceIsStale: boolean;
  /** Value 24h ago implied by the quote's 24h change; null if unknown. */
  value24hAgo: Decimal | null;
};

export type PortfolioValuation = {
  portfolio: Portfolio;
  cash: Decimal;
  reservedCash: Decimal;
  positions: PositionValuation[];
  marketValue: Decimal;
  totalValue: Decimal;
  costBasis: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl: Decimal;
  dayChange: Decimal | null;
  isStale: boolean;
  /** Play money deposited into the portfolio so far. */
  netDeposits: Decimal;
  /** (total value - net deposits) / net deposits, percent; null before any deposit. */
  totalReturnPct: Decimal | null;
};

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly quotes: QuoteStore,
  ) {}

  find(viewer: Viewer): Promise<Portfolio | null> {
    return this.prisma.portfolio.findUnique({
      where: { userId: viewer.userId },
    });
  }

  /** Idempotent: a second call (or a concurrent one) returns the same portfolio. */
  async create(viewer: Viewer): Promise<Portfolio> {
    const existing = await this.find(viewer);
    if (existing) return existing;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cash = await this.accounts.openCustomerAccount(
          tx,
          viewer.userId,
          'USD',
          'PORTFOLIO_CASH',
        );
        const reserved = await this.accounts.openCustomerAccount(
          tx,
          viewer.userId,
          'USD',
          'PORTFOLIO_RESERVED',
        );
        return tx.portfolio.create({
          data: {
            userId: viewer.userId,
            cashAccountId: cash.id,
            reservedAccountId: reserved.id,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'user_id'))
        return (await this.find(viewer))!;
      throw error;
    }
  }

  async require(viewer: Viewer): Promise<Portfolio> {
    const portfolio = await this.find(viewer);
    if (!portfolio)
      throw new AppError('NOT_FOUND', 'Create a portfolio first.');
    return portfolio;
  }

  // Valued at the latest quotes. Positions with stale or missing prices are
  // still shown, but the valuation says so (isStale) rather than hiding it.
  // ponytail: 1 USDT is valued as 1 USD (Binance quotes), see ADR 0008.
  async value(portfolio: Portfolio): Promise<PortfolioValuation> {
    const [accounts, positions] = await Promise.all([
      this.prisma.account.findMany({
        where: {
          id: { in: [portfolio.cashAccountId, portfolio.reservedAccountId] },
        },
        select: { id: true, balance: true },
      }),
      this.prisma.position.findMany({
        where: {
          portfolioId: portfolio.id,
          OR: [{ quantity: { gt: 0 } }, { realizedPnl: { not: 0 } }],
        },
        include: { asset: true },
        orderBy: { assetId: 'asc' },
      }),
    ]);
    const balance = (id: string) =>
      minorToDollars(
        accounts.find((account) => account.id === id)?.balance ?? 0n,
      );
    const quotes = await this.quotes.readMany(
      positions.map((position) => position.assetId),
    );

    let isStale = false;
    let dayChangeKnown = true;
    const valued = positions.map((position): PositionValuation => {
      const quote = quotes.get(position.assetId);
      const held = position.quantity.gt(0);
      const price = quote ? new Decimal(quote.price) : null;
      const priceIsStale =
        held &&
        (!quote || this.quotes.assess(quote, position.asset.category).isStale);
      if (priceIsStale) isStale = true;
      const marketValue = price
        ? position.quantity.times(price).toDecimalPlaces(2)
        : held
          ? null
          : ZERO;
      const change = quote?.change24hPct
        ? new Decimal(quote.change24hPct)
        : null;
      const value24hAgo =
        marketValue && change ? marketValue.div(change.div(100).plus(1)) : null;
      if (held && !value24hAgo) dayChangeKnown = false;
      return {
        asset: position.asset,
        quantity: position.quantity,
        reservedQuantity: position.reservedQuantity,
        costBasis: position.costBasis,
        realizedPnl: position.realizedPnl,
        averagePrice: held
          ? position.costBasis.div(position.quantity).toDecimalPlaces(8)
          : null,
        marketPrice: price,
        marketValue,
        unrealizedPnl:
          marketValue && held ? marketValue.minus(position.costBasis) : null,
        unrealizedPnlPct:
          marketValue && held && position.costBasis.gt(0)
            ? marketValue
                .minus(position.costBasis)
                .div(position.costBasis)
                .times(100)
                .toDecimalPlaces(2)
            : null,
        priceIsStale,
        value24hAgo,
      };
    });

    const sum = (pick: (p: PositionValuation) => Decimal | null) =>
      valued.reduce((total, p) => total.plus(pick(p) ?? ZERO), ZERO);
    // Money in is only ever a simulated deposit (paper cash can't be
    // transferred out), so net deposits = sum of those deposits.
    const deposits = await this.prisma.transfer.aggregate({
      where: {
        toAccountId: portfolio.cashAccountId,
        kind: 'SIMULATED_DEPOSIT',
      },
      _sum: { amount: true },
    });
    const netDeposits = minorToDollars(deposits._sum.amount ?? 0n);
    const cash = balance(portfolio.cashAccountId);
    const reservedCash = balance(portfolio.reservedAccountId);
    const marketValue = sum((p) => p.marketValue);
    return {
      portfolio,
      cash,
      reservedCash,
      positions: valued,
      marketValue,
      totalValue: cash.plus(reservedCash).plus(marketValue),
      costBasis: sum((p) => p.costBasis),
      unrealizedPnl: sum((p) => p.unrealizedPnl),
      realizedPnl: sum((p) => p.realizedPnl),
      dayChange: dayChangeKnown
        ? marketValue
            .minus(sum((p) => p.value24hAgo ?? p.marketValue))
            .toDecimalPlaces(2)
        : null,
      isStale,
      netDeposits,
      totalReturnPct: netDeposits.gt(0)
        ? cash
            .plus(reservedCash)
            .plus(marketValue)
            .minus(netDeposits)
            .div(netDeposits)
            .times(100)
            .toDecimalPlaces(2)
        : null,
    };
  }

  performance(portfolio: Portfolio, since: Date) {
    return this.prisma.portfolioValuation.findMany({
      where: { portfolioId: portfolio.id, at: { gte: since } },
      orderBy: { at: 'asc' },
      take: 2000,
    });
  }

  /** Snapshot every portfolio for the performance chart. */
  async recordValuations(): Promise<string> {
    const portfolios = await this.prisma.portfolio.findMany();
    const at = new Date();
    for (const portfolio of portfolios) {
      const valuation = await this.value(portfolio);
      await this.prisma.portfolioValuation.create({
        data: {
          portfolioId: portfolio.id,
          at,
          totalValue: valuation.totalValue,
          isStale: valuation.isStale,
        },
      });
    }
    return `${portfolios.length} portfolios valued`;
  }
}
