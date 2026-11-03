import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AppError } from '../../shared/errors/app-error';
import type { Viewer } from '../identity/auth.service';
import { MarketDataService } from '../market-data/market-data.service';

const MAX_ITEMS = 50;

@Injectable()
export class WatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {}

  list(viewer: Viewer) {
    return this.prisma.watchlistItem.findMany({
      where: { userId: viewer.userId },
      include: { asset: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Idempotent: adding an asset twice is not an error. */
  async add(viewer: Viewer, assetId: string) {
    const asset = await this.marketData.getAsset(assetId);
    const count = await this.prisma.watchlistItem.count({
      where: { userId: viewer.userId },
    });
    if (count >= MAX_ITEMS)
      throw new AppError(
        'BAD_USER_INPUT',
        `A watchlist holds at most ${MAX_ITEMS} assets.`,
      );
    return this.prisma.watchlistItem.upsert({
      where: { userId_assetId: { userId: viewer.userId, assetId: asset.id } },
      create: { userId: viewer.userId, assetId: asset.id },
      update: {},
      include: { asset: true },
    });
  }

  async remove(viewer: Viewer, assetId: string): Promise<boolean> {
    const { count } = await this.prisma.watchlistItem.deleteMany({
      where: { userId: viewer.userId, assetId },
    });
    return count > 0;
  }
}
