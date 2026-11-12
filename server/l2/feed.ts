import WebSocket from 'ws';
import type { L2RestSnapshot, L2Venue } from '../../shared/l2.ts';
import { L2Book } from './engine.ts';
import { BinanceCooldownError, binanceGovernor } from '../binance-governor.ts';

/**
 * Continuous L2 feed: REST snapshot + WebSocket deltas, buffered until the snapshot is
 * applied. A sequence gap forces a full resync; the book never bridges a gap.
 *
 * This is intentionally separate from `orderbook.ts` (single REST snapshot): the snapshot
 * endpoint has its own refresh clock and is not backed by this continuous state.
 */

interface Delta { bids: Array<[string, string]>; asks: Array<[string, string]>; first: number | null; last: number; previous: number | null; previousLast?: number | null; checksum?: number | null; eventTime: number }
const MAX_BUFFERED_FRAMES = 2_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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
  private bufferedBytes = 0;
  private bufferOverflow = false;
  private syncing = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private backoff = 1_000;
  private generation = 0;
  private resyncTask: Promise<void> | null = null;
  private bootstrapId = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  readonly metrics = { bootstrapAttempts: 0, bootstrapFailures: 0, successfulResyncs: 0, disconnects: 0, cooldowns: 0, lastVerifiedAt: null as number | null };

  constructor(readonly venue: L2Venue, readonly symbol: string) {
    this.book = new L2Book(venue, symbol);
  }

  start(): void {
    if (this.stopped) return;
    // Spread simultaneous feed bootstraps so one process cannot burst all depth snapshots.
    this.startTimer = setTimeout(() => { this.startTimer = null; if (!this.stopped) this.connect(); }, Math.floor(Math.random() * 3_000));
    this.startTimer.unref?.();
    this.watchdog = setInterval(() => {
      const last = this.book.lastMessageTime;
      if (last != null && this.now() - last > 12_000) this.book.markStale();
    }, 5_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.cancelBootstrap();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket?.terminate();
    this.socket = null;
  }

  snapshot() { return this.book.snapshot(this.now()); }
  private now() { return Date.now(); }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.book.markConnecting();
    this.cancelBootstrap();
    this.socket?.terminate();
    const socket = new WebSocket(this.url(), { handshakeTimeout: 10_000 });
    this.socket = socket;
    const stale = () => generation !== this.generation || this.socket !== socket;
    socket.on('open', () => {
      if (stale()) return;
      this.backoff = 1_000;
      const subscription = this.subscription();
      if (subscription) socket.send(JSON.stringify(subscription));
      void this.resync();
    });
    socket.on('message', (raw) => {
      if (stale()) return;
      let message: Record<string, unknown>;
      const text = raw.toString();
      try { message = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      if (message.op === 'pong' || message.event === 'subscribe') return;
      // A venue may push a fresh snapshot on the same socket (OKX after a checksum failure,
      // Bybit on subscribe/reconnect). Snapshots rebuild the book; they are never deltas.
      if ((this.venue === 'okx' && message.action === 'snapshot') || (this.venue === 'bybit' && message.type === 'snapshot')) {
        const row = Array.isArray(message.data) ? message.data[0] : message.data;
        if (row) {
          const installed = this.book.applySnapshot(this.venue === 'bybit' ? this.parseRest({ result: row }) : this.parseRest({ data: [row] }), this.now());
          if (installed) this.cancelBootstrap();
          else void this.resync();
        }
        return;
      }
      const delta = this.parseDelta(message);
      if (!delta) return;
      if (this.syncing) { this.bufferDelta(delta, Buffer.byteLength(text)); return; }
      const result = this.book.applyDelta(delta, this.now());
      if (result.reason === 'not-synced' || this.book.state === 'resyncing') void this.resync();
    });
    socket.on('close', () => { if (stale()) return; this.metrics.disconnects += 1; this.scheduleReconnect(); });
    socket.on('error', () => { if (stale()) return; socket.terminate(); this.scheduleReconnect(); });
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

  private bufferDelta(delta: Delta, bytes: number) {
    if (this.bufferOverflow) return;
    if (this.buffer.length >= MAX_BUFFERED_FRAMES || this.bufferedBytes + bytes > MAX_BUFFERED_BYTES) {
      this.bufferOverflow = true;
      this.buffer = [];
      this.bufferedBytes = 0;
      return;
    }
    this.buffer.push(delta);
    this.bufferedBytes += bytes;
  }

  private cancelBootstrap() {
    this.bootstrapId++;
    this.resyncTask = null;
    this.syncing = false;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.bufferOverflow = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private resync(): Promise<void> {
    if (this.resyncTask) return this.resyncTask;
    if (this.stopped || this.retryTimer || this.reconnectTimer) return Promise.resolve();
    const id = ++this.bootstrapId;
    this.resyncTask = this.doResync(id).finally(() => { if (this.bootstrapId === id) this.resyncTask = null; });
    return this.resyncTask;
  }

  private async doResync(id: number, attempt = 0): Promise<void> {
    if (this.bootstrapId !== id || this.stopped) return;
    this.syncing = true;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.bufferOverflow = false;
    if (attempt === 0) this.metrics.bootstrapAttempts += 1;
    this.book.markResyncing();
    try {
      let payload: unknown;
      if (this.venue === 'binance') payload = await binanceGovernor.json(this.restUrl());
      else {
        const response = await fetch(this.restUrl(), { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
        payload = await response.json();
      }
      if (this.bootstrapId !== id) return;
      // Bybit sequence ids need not be contiguous. Replaying only part of an
      // overflowed buffer could publish a book missing updates.
      if (this.bufferOverflow || !this.book.applySnapshot(this.parseRest(payload), this.now())) throw new Error('Depth bootstrap exceeded capacity');
      const pending = this.buffer;
      this.buffer = [];
      this.bufferedBytes = 0;
      this.syncing = false;
      for (const delta of pending) {
        this.book.applyDelta(delta, this.now());
        if (this.book.state === 'resyncing') throw new Error('Depth bootstrap replay failed');
      }
      this.metrics.successfulResyncs += 1;
      this.metrics.lastVerifiedAt = this.now();
    } catch (error) {
      if (this.bootstrapId !== id) return;
      this.syncing = false;
      this.buffer = [];
      this.bufferedBytes = 0;
      if (attempt === 0) this.metrics.bootstrapFailures += 1;
      if (error instanceof BinanceCooldownError) {
        this.metrics.cooldowns += 1;
        // Respect the exchange cooldown instead of re-requesting snapshots in a loop.
        this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.resync(); }, Math.min(error.retryAfterMs, 300_000));
        return;
      }
      if (attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) + Math.floor(Math.random() * 750))); return this.doResync(id, attempt + 1); }
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
      return { bids: (result.b as Array<[string, string]>) ?? [], asks: (result.a as Array<[string, string]>) ?? [], sequence: { first: null, last: Number(result.u ?? result.seq) }, eventTime: Number(result.cts ?? result.ts ?? Date.now()) };
    }
    const row = ((body.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    return { bids: (row.bids as Array<[string, string]>) ?? [], asks: (row.asks as Array<[string, string]>) ?? [], sequence: { first: null, last: Number(row.seqId) }, eventTime: Number(row.ts ?? Date.now()) };
  }

  private parseDelta(message: Record<string, unknown>): Delta | null {
    if (this.venue === 'binance') {
      if (message.e !== 'depthUpdate') return null;
      return { bids: (message.b as Array<[string, string]>) ?? [], asks: (message.a as Array<[string, string]>) ?? [], first: num(message.U), last: Number(message.u), previous: null, previousLast: num(message.pu), eventTime: Number(message.E ?? Date.now()) };
    }
    if (this.venue === 'bybit') {
      const data = (message.data ?? {}) as Record<string, unknown>;
      if (!String(message.topic ?? '').startsWith('orderbook.')) return null;
      // `u` is the monotonic update id; `seq` is a cross-stream counter and must not be used
      // as an update sequence. `cts` is the venue create time when present.
      return { bids: (data.b as Array<[string, string]>) ?? [], asks: (data.a as Array<[string, string]>) ?? [], first: num(data.u), last: Number(data.u), previous: null, eventTime: Number(data.cts ?? data.ts ?? Date.now()) };
    }
    const arg = (message.arg ?? {}) as Record<string, unknown>;
    if (arg.channel !== 'books') return null;
    const row = ((message.data as Array<Record<string, unknown>>) ?? [])[0];
    if (!row) return null;
    return { bids: (row.bids as Array<[string, string]>) ?? [], asks: (row.asks as Array<[string, string]>) ?? [], first: null, last: Number(row.seqId), previous: num(row.prevSeqId), checksum: num(row.checksum), eventTime: Number(row.ts ?? Date.now()) };
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
