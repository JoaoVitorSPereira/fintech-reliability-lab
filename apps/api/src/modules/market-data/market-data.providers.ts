import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { ProviderHttp } from './provider-http';
import { BinanceAdapter } from './providers/binance';
import { CoinGeckoAdapter } from './providers/coingecko';
import { TwelveDataAdapter } from './providers/twelve-data';

export const STOCK_UNIVERSE = Symbol('STOCK_UNIVERSE');
export type StockUniverse = { symbols: string[]; limited: boolean };

// ponytail: hard-coded ETF list; ask the provider's reference data endpoint
// if the configured universe ever grows beyond a handful of symbols.
export const KNOWN_ETFS = new Set(['SPY', 'QQQ', 'DIA', 'IWM', 'VOO', 'VTI']);

type Config = ConfigService<Env, true>;

export const marketDataProviders: Provider[] = [
  {
    provide: CoinGeckoAdapter,
    inject: [ConfigService, REDIS],
    useFactory: (config: Config, redis: Redis) => {
      const key = config.get('COINGECKO_DEMO_API_KEY', { infer: true });
      return new CoinGeckoAdapter(
        new ProviderHttp(
          {
            name: 'coingecko',
            baseUrl: config.get('COINGECKO_BASE_URL', { infer: true }),
            requestsPerMinute: key ? 25 : 8,
            headers: key ? { 'x-cg-demo-api-key': key } : {},
          },
          redis,
        ),
      );
    },
  },
  {
    provide: BinanceAdapter,
    inject: [ConfigService, REDIS],
    useFactory: (config: Config, redis: Redis) =>
      new BinanceAdapter(
        new ProviderHttp(
          {
            name: 'binance',
            baseUrl: config.get('BINANCE_REST_URL', { infer: true }),
            // Binance allows 6000 request-weight/min per IP; klines cost 2.
            requestsPerMinute: 300,
          },
          redis,
        ),
      ),
  },
  {
    provide: TwelveDataAdapter,
    inject: [ConfigService, REDIS],
    useFactory: (config: Config, redis: Redis) =>
      new TwelveDataAdapter(
        new ProviderHttp(
          {
            name: 'twelve-data',
            baseUrl: config.get('TWELVE_DATA_BASE_URL', { infer: true }),
            requestsPerMinute: 8, // free plan: 8 credits/min
            defaultQuery: {
              apikey:
                config.get('TWELVE_DATA_API_KEY', { infer: true }) ?? 'demo',
            },
          },
          redis,
        ),
      ),
  },
  {
    provide: STOCK_UNIVERSE,
    inject: [ConfigService],
    useFactory: (config: Config): StockUniverse =>
      config.get('TWELVE_DATA_API_KEY', { infer: true })
        ? {
            symbols: config.get('STOCK_SYMBOLS', { infer: true }),
            limited: false,
          }
        : { symbols: ['AAPL'], limited: true },
  },
];
