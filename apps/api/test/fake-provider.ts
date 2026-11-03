import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http';
import { FAKE_PROVIDER_PORT } from './setup-env';

export type FakeRoute = (
  req: IncomingMessage,
  url: URL,
) => { status?: number; body?: unknown; headers?: Record<string, string> };

/**
 * A real HTTP server standing in for CoinGecko / Binance / Twelve Data.
 * Tests swap `routes[path]` to simulate outages, 429s and bad payloads,
 * and read `hits` to assert how many upstream calls were made.
 */
export class FakeProvider {
  readonly routes = new Map<string, FakeRoute>();
  readonly hits = new Map<string, number>();
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      this.hits.set(url.pathname, (this.hits.get(url.pathname) ?? 0) + 1);
      const route = this.routes.get(url.pathname);
      const reply = route
        ? route(req, url)
        : { status: 404, body: { error: 'no route' } };
      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...reply.headers,
      });
      res.end(JSON.stringify(reply.body ?? {}));
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(FAKE_PROVIDER_PORT, '127.0.0.1', resolve),
    );
    this.url = `http://127.0.0.1:${FAKE_PROVIDER_PORT}`;
  }

  hitCount(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
