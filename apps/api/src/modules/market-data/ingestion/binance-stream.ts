import { Logger } from '@nestjs/common';
import { normalizeMiniTicker, type MiniTicker } from '../providers/binance';

const WATCHDOG_MS = 60_000; // miniTicker pushes every second; 60s of silence = dead socket
const MAX_BACKOFF_MS = 30_000;

// One combined-stream WebSocket for all tracked symbols:
//   wss://data-stream.binance.vision/stream?streams=btcusdt@miniTicker/...
// Recovers from: socket errors/closes (Binance also closes every 24h),
// half-open connections (watchdog), and symbol-set changes (resubscribe).
export class BinanceStream {
  private readonly logger = new Logger('BinanceStream');
  private socket: WebSocket | null = null;
  private symbols: string[] = [];
  private attempt = 0;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly baseUrl: string,
    private readonly onTicker: (ticker: MiniTicker) => void,
  ) {}

  get connected(): boolean {
    return (
      this.socket?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastMessageAt < WATCHDOG_MS
    );
  }

  /** Idempotent: reconnects only when the symbol set actually changed. */
  track(symbols: string[]): void {
    const next = [...new Set(symbols)].sort();
    if (next.join() === this.symbols.join() && this.socket) return;
    this.symbols = next;
    this.reconnect('symbol set changed', 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped || this.symbols.length === 0) return;
    const streams = this.symbols
      .map((symbol) => `${symbol.toLowerCase()}@miniTicker`)
      .join('/');
    const socket = new WebSocket(
      `${this.baseUrl.replace(/\/$/, '')}/stream?streams=${streams}`,
    );
    this.socket = socket;
    this.lastMessageAt = Date.now();

    socket.onopen = () => {
      this.logger.log(
        `connected (${this.symbols.length} symbols, attempt ${this.attempt + 1})`,
      );
    };
    socket.onmessage = (event: MessageEvent) => {
      this.lastMessageAt = Date.now();
      this.attempt = 0;
      try {
        const ticker = normalizeMiniTicker(JSON.parse(String(event.data)));
        if (ticker) this.onTicker(ticker);
      } catch {
        // one malformed frame must not kill the stream
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.reconnect('socket closed');
    };
    socket.onerror = () => {
      // onclose follows; reconnection happens there
    };

    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > WATCHDOG_MS)
        this.reconnect('no data for 60s');
    }, WATCHDOG_MS / 2);
  }

  private reconnect(reason: string, delayOverride?: number): void {
    if (this.stopped) return;
    const old = this.socket;
    this.socket = null;
    old?.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // Exponential backoff with full jitter: 1s, 2s, 4s... capped at 30s.
    const delay =
      delayOverride ??
      Math.random() * Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.attempt++);
    if (delayOverride === undefined)
      this.logger.warn(`${reason}; reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
