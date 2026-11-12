import WebSocket from 'ws';
import type { NativeCandleFrame, NativeCandleMarket, NativeCandleUpdate } from '../shared/native-candles.ts';
import { FLOW_INTERVALS } from '../shared/orderflow.ts';
import type { MarketProject } from '../shared/types.ts';
import { TIMEFRAME_INTERVALS } from '../shared/timeframe.ts';
import { LiveSnapshots } from './live-snapshots.ts';
import { binanceMarketWsBase } from './binance-ws-url.ts';
import { asterWsBase } from './aster.ts';

type CandleSocket = Pick<WebSocket, 'terminate' | 'ping' | 'readyState'> & {
  on(event: 'open' | 'pong' | 'close' | 'error', listener: () => void): void;
  on(event: 'message', listener: (raw: WebSocket.RawData) => void): void;
};
type Dial = (url: string) => CandleSocket;
const openSocket: Dial = url => new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 16_384 });

function rawKlineUrl({ exchange, symbol, interval }: NativeCandleMarket) {
  const base = exchange === 'binance' ? binanceMarketWsBase() : asterWsBase();
  return base + '/ws/' + encodeURIComponent(symbol.toLowerCase()) + '@kline_' + interval;
}

function amount(value: unknown) {
  return typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
}

function parseKline(payload: string, market: NativeCandleMarket): NativeCandleUpdate | null {
  const raw = JSON.parse(payload);
  const k = raw?.k;
  if (raw?.e !== 'kline' || raw.s !== market.symbol || k?.s !== market.symbol || k.i !== market.interval ||
      typeof k.x !== 'boolean') return null;
  const time = amount(k.t), eventTime = amount(raw.E);
  const open = amount(k.o), high = amount(k.h), low = amount(k.l), close = amount(k.c);
  const volumeBase = amount(k.v), volumeUsd = amount(k.q);
  if (!Number.isSafeInteger(time) || time <= 0 || time % FLOW_INTERVALS[market.interval] !== 0 ||
      !Number.isSafeInteger(eventTime) || eventTime < time || eventTime > Date.now() + 5_000 ||
      ![open, high, low, close, volumeBase, volumeUsd].every(Number.isFinite) ||
      low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || volumeBase < 0 || volumeUsd < 0) return null;
  return { candle: { time, open, high, low, close, volumeBase, volumeUsd }, eventTime, closed: k.x };
}

/** A native kline reports cumulative OHLCV. Keep the previous bar for late closes and rollover. */
function retainUpdate(bars: NativeCandleUpdate[], update: NativeCandleUpdate) {
  const previous = bars.find(bar => bar.candle.time === update.candle.time);
  if (previous) {
    if (previous.closed && !update.closed) return bars;
    if (previous.closed === update.closed && previous.eventTime > update.eventTime) return bars;
    return bars.map(bar => bar === previous ? update : bar);
  }
  if (bars.length === 2 && update.candle.time < bars[0].candle.time) return bars;
  return [...bars, update].sort((a, b) => a.candle.time - b.candle.time).slice(-2);
}

function openCandleSource(market: NativeCandleMarket, enabled: () => boolean, dial: Dial) {
  let frame: NativeCandleFrame = { ...market, bars: [] };
  let socket: CandleSocket | undefined;
  let reconnect: NodeJS.Timeout | undefined;
  let stopped = false, retryMs = 1000, lastPong = 0, lastPing = 0;
  const connect = () => {
    if (stopped) return;
    lastPing = lastPong = Date.now();
    const current = dial(rawKlineUrl(market));
    socket = current;
    const heard = () => { lastPong = Date.now(); };
    current.on('open', heard);
    current.on('pong', heard);
    current.on('message', bytes => {
      if (stopped || socket !== current) return;
      try {
        const update = parseKline(bytes.toString(), market);
        if (!update) return;
        retryMs = 1000;
        heard();
        const bars = retainUpdate(frame.bars, update);
        if (bars !== frame.bars) frame = { ...market, bars };
      } catch { /* Ignore malformed upstream frames. */ }
    });
    current.on('error', () => current.terminate());
    current.on('close', () => {
      if (socket !== current || stopped) return;
      socket = undefined;
      reconnect = setTimeout(connect, retryMs).unref();
      retryMs = Math.min(30_000, retryMs * 2);
    });
  };
  connect();
  return {
    sample(): NativeCandleFrame | null {
      if (!enabled()) return null;
      const now = Date.now();
      if (socket?.readyState === WebSocket.OPEN && now - lastPing >= 30_000) {
        lastPing = now;
        if (now - lastPong > 65_000) socket.terminate();
        else socket.ping();
      }
      return frame;
    },
    release() {
      stopped = true;
      clearTimeout(reconnect);
      socket?.terminate();
    },
  };
}

export function createCandleChannel(projects: () => MarketProject[], dial: Dial = openSocket) {
  const snapshots = new LiveSnapshots<NativeCandleFrame>('candles', 1000, undefined, 64);
  let checkedAt = -Infinity;
  let enabled = new Set<string>();
  const canStream = (key: string) => {
    const now = Date.now();
    if (now < checkedAt || now - checkedAt >= 1000) {
      const markets = new Set<string>();
      for (const project of projects()) {
        if (project.archived || !project.monitoring.streamingEnabled || project.monitoring.collectionMode === 'paused') continue;
        for (const market of project.markets) {
          if (market.marketType === 'perpetual') markets.add(market.exchange + ':' + market.symbol.toUpperCase());
        }
      }
      enabled = markets;
      checkedAt = now;
    }
    return enabled.has(key);
  };
  return (params: Record<string, string>, emit: (frame: unknown) => void, unavailable: () => void) => {
    const { exchange, marketType } = params;
    const symbol = params.symbol?.toUpperCase();
    const interval = TIMEFRAME_INTERVALS.find(value => value === params.interval);
    const marketKey = exchange + ':' + symbol;
    if ((exchange !== 'binance' && exchange !== 'aster') || marketType !== 'perpetual' || !interval ||
        !symbol || !/^[\p{L}\p{N}_-]{1,80}$/u.test(symbol) || !canStream(marketKey)) {
      unavailable();
      return () => {};
    }
    const create = () => openCandleSource({ exchange, marketType, symbol, interval }, () => canStream(marketKey), dial);
    return snapshots.listen(marketKey + ':' + interval, create, emit, unavailable);
  };
}
