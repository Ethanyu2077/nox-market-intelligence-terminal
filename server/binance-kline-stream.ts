import WebSocket from 'ws';
import { binanceGovernor } from './binance-governor.ts';
import { binanceMarketWsBase } from './binance-ws-url.ts';

/**
 * Incremental closed klines over WebSocket. REST is used only to bootstrap a symbol/interval
 * (through the governor); afterwards closed candles arrive as `kline` events.
 */
export type StreamCandle = { time: number; close: number; volume: number };
const WS = binanceMarketWsBase();
const REST = process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com';
const MAX = 600;
const MAX_STREAMS = 128;
const IDLE_MS = 10 * 60_000;

type KlineSocket = Pick<WebSocket, 'terminate'> & {
  on(event: 'open' | 'close' | 'error', listener: () => void): void;
  on(event: 'message', listener: (raw: WebSocket.RawData) => void): void;
};
interface Entry {
  candles: StreamCandle[];
  socket: KlineSocket | null;
  ready: boolean;
  retry: number;
  lastAt: number;
  loaded?: { end: number; limit: number };
  expiry?: NodeJS.Timeout;
  reconnect?: NodeJS.Timeout;
}

export function mergeCandle(candles: StreamCandle[], candle: StreamCandle): StreamCandle[] {
  const next = candles.filter((item) => item.time !== candle.time);
  next.push(candle);
  next.sort((a, b) => a.time - b.time);
  return next.slice(-MAX);
}

export class BinanceKlineStream {
  private entries = new Map<string, Entry>();

  constructor(private readonly openSocket: (url: string) => KlineSocket = url => new WebSocket(url)) {}

  async get(symbol: string, interval: string, limit: number, end: number): Promise<StreamCandle[]> {
    const intervalMs = interval === '1m' ? 60_000 : interval === '5m' ? 300_000 : undefined;
    if (!intervalMs) throw new Error('Unsupported kline interval');
    const key = `${symbol.toUpperCase()}:${interval}`;
    let entry = this.entries.get(key);
    if (!entry) {
      // Beyond the socket budget, serve the same candles from REST for this request.
      if (this.entries.size >= MAX_STREAMS) return (await this.bootstrap(symbol, interval, limit, end)).slice(-limit);
      entry = { candles: [], socket: null, ready: false, retry: 1_000, lastAt: 0 };
      this.entries.set(key, entry);
    }
    const current = entry;
    clearTimeout(current.expiry);
    current.expiry = setTimeout(() => {
      this.entries.delete(key);
      clearTimeout(current.reconnect);
      current.socket?.terminate();
    }, IDLE_MS).unref();
    const needsBootstrap = entry.candles.length < limit || (entry.candles.at(-1)?.time ?? 0) < end - 2 * intervalMs;
    if (needsBootstrap && !(entry.loaded?.end === end && entry.loaded.limit >= limit)) {
      const seed = await this.bootstrap(symbol, interval, limit, end);
      // Keep closes received by the socket while REST was in flight.
      if (!entry.loaded || entry.loaded.end <= end) {
        const newer = entry.candles.filter(candle => candle.time > (seed.at(-1)?.time ?? 0));
        entry.candles = [...seed, ...newer].slice(-MAX);
        entry.loaded = { end, limit };
      }
    }
    this.connect(key, entry, symbol, interval, intervalMs);
    return entry.candles.filter(c => c.time <= end).slice(-limit);
  }

  private async bootstrap(symbol: string, interval: string, limit: number, end: number) {
    const url = `${REST}/fapi/v1/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=${Math.min(500, Math.max(limit, 100))}&endTime=${end - 1}`;
    const raw = await binanceGovernor.json<Array<Array<string | number>>>(url);
    return raw.filter((row) => Number(row[6]) < end).map((row) => ({ time: Number(row[6]) + 1, close: Number(row[4]), volume: Number(row[7]) })).filter((row) => Number.isFinite(row.time) && Number.isFinite(row.close) && row.close > 0 && Number.isFinite(row.volume));
  }

  private connect(key: string, entry: Entry, symbol: string, interval: string, intervalMs: number) {
    if (this.entries.get(key) !== entry || entry.socket || entry.reconnect) return;
    const socket = this.openSocket(`${WS}/ws/${encodeURIComponent(symbol.toLowerCase())}@kline_${interval}`);
    entry.socket = socket;
    socket.on('open', () => { entry.retry = 1_000; entry.ready = true; });
    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as { k?: { t: number; c: string; q: string; x: boolean } };
        if (!payload.k?.x) return;
        const candle = { time: Number(payload.k.t) + intervalMs, close: Number(payload.k.c), volume: Number(payload.k.q) };
        if (!Number.isFinite(candle.time) || !Number.isFinite(candle.close) || candle.close <= 0 || !Number.isFinite(candle.volume)) return;
        entry.candles = mergeCandle(entry.candles, candle);
        entry.lastAt = Date.now();
      } catch { /* ignore malformed */ }
    });
    socket.on('close', () => {
      entry.socket = null;
      entry.ready = false;
      if (this.entries.get(key) !== entry) return;
      entry.retry = Math.min(30_000, entry.retry * 2);
      entry.reconnect = setTimeout(() => {
        entry.reconnect = undefined;
        this.connect(key, entry, symbol, interval, intervalMs);
      }, entry.retry).unref();
    });
    socket.on('error', () => { try { socket.terminate(); } catch { /* ignore */ } });
  }

  status() {
    return [...this.entries.entries()].map(([key, entry]) => ({ key, candles: entry.candles.length, ready: entry.ready, lastAt: entry.lastAt }));
  }
}

export const binanceKlineStream = new BinanceKlineStream();
