import WebSocket from 'ws';
import { binanceGovernor } from './binance-governor.ts';

/**
 * Incremental 5m klines over WebSocket. REST is used only to bootstrap a symbol/interval
 * (through the governor); afterwards closed candles arrive as `kline` events.
 */
export type StreamCandle = { time: number; close: number; volume: number };
const WS = process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com';
const REST = process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com';
const MAX = 600;

interface Entry { candles: StreamCandle[]; socket: WebSocket | null; ready: boolean; retry: number; lastAt: number }

export function mergeCandle(candles: StreamCandle[], candle: StreamCandle): StreamCandle[] {
  const next = candles.filter((item) => item.time !== candle.time);
  next.push(candle);
  next.sort((a, b) => a.time - b.time);
  return next.slice(-MAX);
}

export class BinanceKlineStream {
  private entries = new Map<string, Entry>();

  private key(symbol: string, interval: string) { return `${symbol.toUpperCase()}:${interval}`; }

  async get(symbol: string, interval: string, limit: number, end: number): Promise<StreamCandle[]> {
    const key = this.key(symbol, interval);
    let entry = this.entries.get(key);
    if (!entry) { entry = { candles: [], socket: null, ready: false, retry: 1_000, lastAt: 0 }; this.entries.set(key, entry); }
    const needsBootstrap = entry.candles.length < limit || (entry.candles.at(-1)?.time ?? 0) < end - 2 * 300_000;
    if (needsBootstrap) await this.bootstrap(key, entry, symbol, interval, limit, end);
    this.connect(key, entry, symbol, interval);
    return entry.candles.slice(-limit);
  }

  private async bootstrap(key: string, entry: Entry, symbol: string, interval: string, limit: number, end: number) {
    const url = `${REST}/fapi/v1/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=${Math.min(500, Math.max(limit, 100))}&endTime=${end - 1}`;
    const raw = await binanceGovernor.json<Array<Array<string | number>>>(url);
    entry.candles = raw.filter((row) => Number(row[6]) < end).map((row) => ({ time: Number(row[0]) + 300_000, close: Number(row[4]), volume: Number(row[7]) })).filter((row) => Number.isFinite(row.time) && row.close > 0 && Number.isFinite(row.volume));
  }

  private connect(key: string, entry: Entry, symbol: string, interval: string) {
    if (entry.socket) return;
    const socket = new WebSocket(`${WS}/ws/${symbol.toLowerCase()}@kline_${interval}`);
    entry.socket = socket;
    socket.on('open', () => { entry.retry = 1_000; entry.ready = true; });
    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as { k?: { t: number; c: string; q: string; x: boolean } };
        if (!payload.k?.x) return;
        entry.candles = mergeCandle(entry.candles, { time: payload.k.t + 300_000, close: Number(payload.k.c), volume: Number(payload.k.q) });
        entry.lastAt = Date.now();
      } catch { /* ignore malformed */ }
    });
    socket.on('close', () => { entry.socket = null; entry.ready = false; setTimeout(() => this.connect(key, entry, symbol, interval), Math.min(30_000, entry.retry *= 2)); });
    socket.on('error', () => { try { socket.terminate(); } catch { /* ignore */ } });
  }

  status() {
    return [...this.entries.entries()].map(([key, entry]) => ({ key, candles: entry.candles.length, ready: entry.ready, lastAt: entry.lastAt }));
  }
}

export const binanceKlineStream = new BinanceKlineStream();
