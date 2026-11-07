import WebSocket from 'ws';
import type { ExchangeId } from '../shared/types.ts';
import { openMarketStream } from './binance.ts';
import { getExchangeInstruments } from './exchanges.ts';

type EventHandler = (payload: unknown) => void;
type StateHandler = (state: string, detail?: string) => void;
type Subscription = { url: string; messages: unknown[]; ping?: unknown | string; protocol?: string };

async function kucoinSubscription(symbol: string): Promise<Subscription> {
  const response = await fetch('https://api-futures.kucoin.com/api/v1/bullet-public', { method: 'POST', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`KuCoin WebSocket token HTTP ${response.status}`);
  const payload = await response.json() as { data?: { token?: string; instanceServers?: Array<{ endpoint?: string }> } };
  const token = payload.data?.token; const endpoint = payload.data?.instanceServers?.[0]?.endpoint;
  if (!token || !endpoint) throw new Error('KuCoin WebSocket token unavailable');
  const id = `${Date.now()}`;
  return { url: `${endpoint}?token=${encodeURIComponent(token)}&connectId=${id}`, messages: [
    { id: `${id}-ticker`, type: 'subscribe', topic: `/contractMarket/ticker:${symbol}`, privateChannel: false, response: true },
    { id: `${id}-trade`, type: 'subscribe', topic: `/contractMarket/execution:${symbol}`, privateChannel: false, response: true }
  ], ping: { id, type: 'ping' } };
}

async function subscription(exchange: Exclude<ExchangeId, 'binance'>, symbol: string): Promise<Subscription> {
  if (exchange === 'bybit') return { url: 'wss://stream.bybit.com/v5/public/linear', messages: [{ op: 'subscribe', args: [`publicTrade.${symbol}`, `tickers.${symbol}`] }], ping: { op: 'ping' } };
  if (exchange === 'okx') return { url: 'wss://ws.okx.com:443/ws/v5/public', messages: [{ op: 'subscribe', args: [{ channel: 'trades', instId: symbol }, { channel: 'tickers', instId: symbol }, { channel: 'open-interest', instId: symbol }, { channel: 'funding-rate', instId: symbol }] }], ping: 'ping' };
  if (exchange === 'bitget') return { url: 'wss://ws.bitget.com/v2/ws/public', messages: [{ op: 'subscribe', args: [{ instType: 'USDT-FUTURES', channel: 'trade', instId: symbol }, { instType: 'USDT-FUTURES', channel: 'ticker', instId: symbol }] }], ping: 'ping' };
  if (exchange === 'gate') return { url: 'wss://fx-ws.gateio.ws/v4/ws/usdt', messages: [{ time: Math.floor(Date.now() / 1000), channel: 'futures.trades', event: 'subscribe', payload: [symbol] }, { time: Math.floor(Date.now() / 1000), channel: 'futures.tickers', event: 'subscribe', payload: [symbol] }] };
  if (exchange === 'mexc') return { url: 'wss://contract.mexc.com/edge', messages: [{ method: 'sub.deal', param: { symbol } }, { method: 'sub.ticker', param: { symbol } }], ping: { method: 'ping' } };
  return kucoinSubscription(symbol);
}

function n(value: unknown) { if (value == null || value === '') return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
export function normalizeExchangeMessage(exchange: Exclude<ExchangeId, 'binance'>, message: Record<string, unknown>, contractMultiplier = 1) {
  const output: unknown[] = []; const data = message.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  if (exchange === 'bybit') {
    const topic = String(message.topic ?? ''); const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (topic.startsWith('publicTrade.')) for (const row of rows) output.push({ kind: 'trade', id: row.i ?? `${row.T}:${row.S}:${row.p}:${row.v}`, price: n(row.p), quantity: n(row.v), side: row.S, time: n(row.T) });
    if (topic.startsWith('tickers.') && rows[0]) output.push({ kind: 'ticker', price: n(rows[0].lastPrice), markPrice: n(rows[0].markPrice), change24hPct: n(rows[0].price24hPcnt) == null ? null : n(rows[0].price24hPcnt)! * 100, volumeBase: n(rows[0].volume24h), volumeUsd: n(rows[0].turnover24h), fundingRate: n(rows[0].fundingRate), nextFundingTime: n(rows[0].nextFundingTime), eventTime: n(message.ts) ?? Date.now() });
  } else if (exchange === 'okx') {
    const arg = message.arg as Record<string, unknown> | undefined; const rows = Array.isArray(data) ? data : [];
    if (arg?.channel === 'trades') for (const row of rows) output.push({ kind: 'trade', id: row.tradeId, price: n(row.px), quantity: n(row.sz) == null ? null : n(row.sz)! * contractMultiplier, side: row.side, time: n(row.ts) });
    if (arg?.channel === 'tickers' && rows[0]) { const last = n(rows[0].last), open = n(rows[0].open24h), baseVolume = n(rows[0].volCcy24h); output.push({ kind: 'ticker', price: last, change24hPct: last != null && open ? (last / open - 1) * 100 : null, volumeBase: baseVolume, volumeUsd: baseVolume != null && last != null ? baseVolume * last : n(rows[0].volCcyQuote24h), eventTime: n(rows[0].ts) ?? Date.now() }); }
    if (arg?.channel === 'open-interest' && rows[0]) output.push({ kind: 'openInterest', oiBase: n(rows[0].oiCcy), oiUsd: n(rows[0].oiUsd), eventTime: n(rows[0].ts) ?? Date.now() });
    if (arg?.channel === 'funding-rate' && rows[0]) output.push({ kind: 'funding', fundingRate: n(rows[0].fundingRate), nextFundingTime: n(rows[0].nextFundingTime), eventTime: n(rows[0].ts) ?? Date.now() });
  } else if (exchange === 'bitget') {
    const arg = message.arg as Record<string, unknown> | undefined; const rows = Array.isArray(data) ? data : [];
    if (arg?.channel === 'trade') for (const row of rows) output.push({ kind: 'trade', id: row.tradeId ?? `${row.ts}:${row.side}:${row.price}:${row.size}`, price: n(row.price), quantity: n(row.size), side: row.side, time: n(row.ts) });
    if (arg?.channel === 'ticker' && rows[0]) output.push({ kind: 'ticker', price: n(rows[0].lastPr), markPrice: n(rows[0].markPrice), change24hPct: n(rows[0].change24h) == null ? null : n(rows[0].change24h)! * 100, volumeBase: n(rows[0].baseVolume), volumeUsd: n(rows[0].usdtVolume), fundingRate: n(rows[0].fundingRate), nextFundingTime: n(rows[0].nextFundingTime), eventTime: n(message.ts) ?? Date.now() });
  } else if (exchange === 'gate') {
    const channel = String(message.channel ?? ''); const result = message.result as Record<string, unknown> | Array<Record<string, unknown>> | undefined; const rows = Array.isArray(result) ? result : result ? [result] : [];
    if (channel === 'futures.trades') for (const row of rows) output.push({ kind: 'trade', id: row.id, price: n(row.price), quantity: Math.abs(n(row.size) ?? 0) * contractMultiplier, side: (n(row.size) ?? 0) >= 0 ? 'Buy' : 'Sell', time: (n(row.create_time_ms) ?? Date.now()) });
    if (channel === 'futures.tickers' && rows[0]) output.push({ kind: 'ticker', price: n(rows[0].last), markPrice: n(rows[0].mark_price), change24hPct: n(rows[0].change_percentage), volumeBase: n(rows[0].volume_24h_base), volumeUsd: n(rows[0].volume_24h_quote), fundingRate: n(rows[0].funding_rate), eventTime: (n(message.time_ms) ?? Date.now()) });
  } else if (exchange === 'kucoin') {
    const topic = String(message.topic ?? ''); const row = data && !Array.isArray(data) ? data : undefined;
    if (topic.includes('execution') && row) output.push({ kind: 'trade', id: row.tradeId ?? row.sequence, price: n(row.price), quantity: n(row.size) == null ? null : n(row.size)! * contractMultiplier, side: row.side, time: n(row.ts) ? n(row.ts)! / 1_000_000 : Date.now() });
    if (topic.includes('ticker') && row) { const price = n(row.price ?? row.lastTradePrice); if (price != null) output.push({ kind: 'ticker', price, eventTime: n(row.ts) ? n(row.ts)! / 1_000_000 : Date.now() }); }
  } else {
    const channel = String(message.channel ?? ''); const row = data && !Array.isArray(data) ? data : undefined;
    if (channel.includes('deal')) { const deals = Array.isArray(data) ? data : (row?.deals as Array<Record<string, unknown>> ?? []); for (const deal of deals) output.push({ kind: 'trade', id: deal.i ?? deal.id ?? `${deal.t}:${deal.p}:${deal.v}`, price: n(deal.p), quantity: n(deal.v) == null ? null : n(deal.v)! * contractMultiplier, side: Number(deal.T ?? deal.S) === 1 ? 'Buy' : 'Sell', time: (n(deal.t) ?? Date.now()) }); }
    if (channel.includes('ticker') && row) output.push({ kind: 'ticker', price: n(row.lastPrice), markPrice: n(row.fairPrice), change24hPct: n(row.riseFallRate) == null ? null : n(row.riseFallRate)! * 100, volumeBase: n(row.volume24) == null ? null : n(row.volume24)! * contractMultiplier, volumeUsd: n(row.amount24), fundingRate: n(row.fundingRate), nextFundingTime: n(row.nextSettleTime), eventTime: n(row.timestamp) ?? Date.now() });
  }
  return output;
}

function openExchangeStreamRaw(exchange: ExchangeId, symbol: string, onEvent: EventHandler, onState: StateHandler) {
  if(exchange==='upbit'||exchange==='bithumb'){onState('degraded','KRW spot REST only; derivatives WebSocket is unavailable');return ()=>{};}
  if (exchange === 'binance') return openMarketStream(symbol, onEvent, onState);
  let socket: WebSocket | undefined; let stopped = false; let retry = 1_000; let reconnectTimer: NodeJS.Timeout | undefined; let pingTimer: NodeJS.Timeout | undefined;
  const seen = new Set<string>(); const order: string[] = [];
  const connect = async () => {
    onState('connecting');
    try {
      const config = await subscription(exchange, symbol); if (stopped) return;
      const needsMultiplier = exchange === 'okx' || exchange === 'gate' || exchange === 'kucoin' || exchange === 'mexc';
      const multiplier = needsMultiplier ? (await getExchangeInstruments(exchange)).find((item) => item.nativeSymbol === symbol && item.marketType === 'perpetual')?.contractMultiplier : 1;
      if (multiplier == null || multiplier <= 0) throw new Error('Contract multiplier unavailable; stream excluded');
      socket = new WebSocket(config.url);
      socket.on('open', () => {
        retry = 1_000; for (const message of config.messages) socket?.send(typeof message === 'string' ? message : JSON.stringify(message));
        if (config.ping) pingTimer = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(typeof config.ping === 'string' ? config.ping : JSON.stringify(config.ping)); }, 18_000);
        onState('live');
      });
      socket.on('message', (raw) => {
        if (raw.toString() === 'pong') return;
        try { const message = JSON.parse(raw.toString()) as Record<string, unknown>; for (const event of normalizeExchangeMessage(exchange, message, multiplier)) { const row = event as Record<string, unknown>; if (row.kind === 'trade') { const id = String(row.id); if (seen.has(id)) continue; seen.add(id); order.push(id); if (order.length > 2_048) seen.delete(order.shift()!); } onEvent({ exchange, stream: row.kind, data: row }); } } catch { onState('degraded', 'Invalid upstream payload'); }
      });
      socket.on('error', (error) => onState('degraded', error.message));
      socket.on('close', () => { if (pingTimer) clearInterval(pingTimer); if (stopped) return; onState('stale', `Reconnecting in ${Math.round(retry / 1000)}s`); reconnectTimer = setTimeout(() => void connect(), retry); retry = Math.min(retry * 2, 30_000); });
    } catch (error) { if (stopped) return; onState('stale', error instanceof Error ? error.message : 'WebSocket setup failed'); reconnectTimer = setTimeout(() => void connect(), retry); retry = Math.min(retry * 2, 30_000); }
  };
  void connect();
  return () => { stopped = true; if (pingTimer) clearInterval(pingTimer); if (reconnectTimer) clearTimeout(reconnectTimer); socket?.close(); };
}

const sharedStreams = new Map<string, { listeners: Set<{ event: EventHandler; state: StateHandler }>; stop: () => void; status: [string, string?] }>();
const STREAM_VENUES = new Set<ExchangeId>(['binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin', 'mexc']);

export function openExchangeStream(exchange: ExchangeId, symbol: string, onEvent: EventHandler, onState: StateHandler) {
  // Never route a venue without a verified adapter through another venue's socket.
  if (!STREAM_VENUES.has(exchange)) { onState('stale', `${exchange} has no verified public WebSocket adapter`); return () => {}; }
  const key = `${exchange}:${symbol}`;
  let entry = sharedStreams.get(key);
  if (!entry) {
    const listeners = new Set<{ event: EventHandler; state: StateHandler }>();
    entry = { listeners, stop: () => {}, status: ['connecting'] };
    sharedStreams.set(key, entry);
    const current = entry;
    current.stop = openExchangeStreamRaw(exchange, symbol, data => { for (const listener of listeners) listener.event(data); }, (state, detail) => { current.status = [state, detail]; for (const listener of listeners) listener.state(state, detail); });
  }
  const listener = { event: onEvent, state: onState }; entry.listeners.add(listener); onState(...entry.status);
  const current = entry;
  return () => { current.listeners.delete(listener); if (!current.listeners.size) { current.stop(); sharedStreams.delete(key); } };
}
