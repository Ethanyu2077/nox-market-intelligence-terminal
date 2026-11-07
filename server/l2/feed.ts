import WebSocket from 'ws';
import type { L2RestSnapshot, L2Venue } from '../../shared/l2.ts';
import { L2Book } from './engine.ts';

/**
 * Continuous L2 feed: REST snapshot + WebSocket deltas, buffered until the snapshot is
 * applied. A sequence gap forces a full resync; the book never bridges a gap.
 *
 * This is intentionally separate from `orderbook.ts` (single REST snapshot): the snapshot
 * endpoint keeps its own 2s TTL and is not backed by this continuous state.
 */

interface Delta { bids: Array<[string, string]>; asks: Array<[string, string]>; first: number | null; last: number; previous: number | null; eventTime: number }

const REST = {
  binance: process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com',
  bybit: 'https://api.bybit.com',
  okx: 'https://www.okx.com',
};

const WS = {
  binance: process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com',
  bybit: 'wss://stream.bybit.com/v5/public/linear',
  okx: 'wss://ws.okx.com:443/ws/v5/public',
};

function num(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }

export class L2Feed {
  readonly book: L2Book;
  private socket: WebSocket | null = null;
  private buffer: Delta[] = [];
  private syncing = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private backoff = 1_000;

  constructor(readonly venue: L2Venue, readonly symbol: string) {
    this.book = new L2Book(venue, symbol);
  }

  start(): void {
    if (this.stopped) return;
    this.connect();
    this.watchdog = setInterval(() => {
      const last = this.book.snapshot(this.now()).lastMessageAt;
      if (last != null && this.now() - last > 12_000) this.book.markStale();
    }, 5_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket?.terminate();
    this.socket = null;
  }

  snapshot() { return this.book.snapshot(this.now()); }
  private now() { return Date.now(); }

  private connect(): void {
    if (this.stopped) return;
    this.book.markConnecting();
    const socket = new WebSocket(this.url(), { handshakeTimeout: 10_000 });
    this.socket = socket;
    socket.on('open', () => {
      this.backoff = 1_000;
      const subscription = this.subscription();
      if (subscription) socket.send(JSON.stringify(subscription));
      void this.resync();
    });
    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (message.op === 'pong' || message.event === 'subscribe') return;
      // OKX can push a fresh snapshot on the same socket (e.g. after a checksum failure).
      if (this.venue === 'okx' && message.action === 'snapshot') {
        const row = ((message.data as Array<Record<string, unknown>>) ?? [])[0];
        if (row) this.book.applySnapshot(this.parseRest({ data: [row] }), this.now());
        return;
      }
      const delta = this.parseDelta(message);
      if (!delta) return;
      if (this.syncing) { this.buffer = [...this.buffer, delta].slice(-2_000); return; }
      const result = this.book.applyDelta(delta, this.now());
      if (result.reason === 'gap') void this.resync();
    });
    socket.on('close', () => this.scheduleReconnect());
    socket.on('error', () => { socket.terminate(); this.scheduleReconnect(); });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.book.markResyncing();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(30_000, Math.round(this.backoff * 1.8));
  }

  private async resync(attempt = 0): Promise<void> {
    if (this.stopped) return;
    this.syncing = true;
    this.book.markResyncing();
    try {
      const response = await fetch(this.restUrl(), { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
      this.book.applySnapshot(this.parseRest(await response.json()), this.now());
      const pending = this.buffer;
      this.buffer = [];
      this.syncing = false;
      for (const delta of pending) {
        const result = this.book.applyDelta(delta, this.now());
        if (result.reason === 'gap') { if (attempt < 2) void this.resync(attempt + 1); return; }
      }
    } catch {
      this.syncing = false;
      if (attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); void this.resync(attempt + 1); }
      else this.scheduleReconnect();
    }
  }

  private url(): string {
    if (this.venue === 'binance') return `${WS.binance}/ws/${this.symbol.toLowerCase()}@depth@100ms`;
    return WS[this.venue];
  }

  private subscription(): unknown {
    if (this.venue === 'binance') return null;
    if (this.venue === 'bybit') return { op: 'subscribe', args: [`orderbook.50.${this.symbol}`] };
    return { op: 'subscribe', args: [{ channel: 'books', instId: this.symbol }] };
  }

  private restUrl(): string {
    const symbol = encodeURIComponent(this.symbol);
    if (this.venue === 'binance') return `${REST.binance}/fapi/v1/depth?symbol=${symbol}&limit=1000`;
    if (this.venue === 'bybit') return `${REST.bybit}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`;
    return `${REST.okx}/api/v5/market/books?instId=${symbol}&sz=50`;
  }

  private parseRest(payload: unknown): L2RestSnapshot {
    const body = payload as Record<string, unknown>;
    if (this.venue === 'binance') {
      return { bids: (body.bids as Array<[string, string]>) ?? [], asks: (body.asks as Array<[string, string]>) ?? [], sequence: { first: null, last: Number(body.lastUpdateId) }, eventTime: Number(body.E ?? body.T ?? Date.now()) };
    }
    if (this.venue === 'bybit') {
      const result = (body.result ?? {}) as Record<string, unknown>;
      return { bids: (result.b as Array<[string, string]>) ?? [], asks: (result.a as Array<[string, string]>) ?? [], sequence: { first: null, last: Number(result.seq ?? result.u) }, eventTime: Number(result.ts ?? Date.now()) };
    }
    const row = ((body.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    return { bids: (row.bids as Array<[string, string]>) ?? [], asks: (row.asks as Array<[string, string]>) ?? [], sequence: { first: null, last: Number(row.seqId) }, eventTime: Number(row.ts ?? Date.now()) };
  }

  private parseDelta(message: Record<string, unknown>): Delta | null {
    if (this.venue === 'binance') {
      if (message.e !== 'depthUpdate') return null;
      return { bids: (message.b as Array<[string, string]>) ?? [], asks: (message.a as Array<[string, string]>) ?? [], first: num(message.U), last: Number(message.u), previous: null, eventTime: Number(message.E ?? Date.now()) };
    }
    if (this.venue === 'bybit') {
      const data = (message.data ?? {}) as Record<string, unknown>;
      if (!String(message.topic ?? '').startsWith('orderbook.')) return null;
      return { bids: (data.b as Array<[string, string]>) ?? [], asks: (data.a as Array<[string, string]>) ?? [], first: num(data.u), last: Number(data.seq), previous: null, eventTime: Number(data.ts ?? Date.now()) };
    }
    const arg = (message.arg ?? {}) as Record<string, unknown>;
    if (arg.channel !== 'books') return null;
    const row = ((message.data as Array<Record<string, unknown>>) ?? [])[0];
    if (!row) return null;
    return { bids: (row.bids as Array<[string, string]>) ?? [], asks: (row.asks as Array<[string, string]>) ?? [], first: null, last: Number(row.seqId), previous: num(row.prevSeqId), eventTime: Number(row.ts ?? Date.now()) };
  }
}

const feeds = new Map<string, { feed: L2Feed; refs: number }>();

/** Reference-counted feed so multiple SSE subscribers share one socket. */
export function acquireL2(venue: L2Venue, symbol: string): { feed: L2Feed; release: () => void } {
  const key = `${venue}:${symbol}`;
  let entry = feeds.get(key);
  if (!entry) {
    const feed = new L2Feed(venue, symbol);
    feed.start();
    entry = { feed, refs: 0 };
    feeds.set(key, entry);
  }
  entry.refs += 1;
  const current = entry;
  let released = false;
  return {
    feed: current.feed,
    release: () => {
      if (released) return;
      released = true;
      current.refs -= 1;
      if (current.refs <= 0) {
        current.feed.stop();
        feeds.delete(key);
      }
    },
  };
}
