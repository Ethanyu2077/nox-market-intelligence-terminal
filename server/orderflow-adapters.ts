import WebSocket from 'ws';
import { CCXT_EXCHANGE_IDS, type Instrument, type ProjectMarket } from '../shared/types.ts';
import type { FlowTrade, LiquidationEvent } from '../shared/orderflow.ts';
import { getExchangeInstruments } from './exchanges.ts';
import { openExchangeStream } from './exchange-streams.ts';
import { venueBreakers } from './venue-health.ts';

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
function num(value: unknown) { if (value == null || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
export function normalizeFlowTrade(market: ProjectMarket, row: Row, multiplier: number | null, source: FlowTrade['source'] = 'rest'): FlowTrade | null {
  if (row.isBlockTrade === true || row.BT === true) return null; // Negotiated block prints are not book aggressor flow.
  let id: unknown, price: unknown, quantity: unknown, side: unknown, time: unknown;
  switch (market.exchange) {
    case 'binance': id = row.a; price = row.p; quantity = row.q; side = typeof row.m === 'boolean' ? (row.m ? 'sell' : 'buy') : null; time = row.T; break;
    case 'bybit': id = row.execId ?? row.i; price = row.price ?? row.p; quantity = row.size ?? row.v; side = row.side ?? row.S; time = row.time ?? row.T; break;
    case 'okx': id = row.tradeId; price = row.px; quantity = row.sz; side = row.side; time = row.ts; break;
    case 'bitget': id = row.tradeId; price = row.price; quantity = row.size; side = row.side; time = row.ts; break;
    case 'gate': id = row.id; price = row.price; quantity = market.marketType === 'spot' ? row.amount : Math.abs(num(row.size) ?? NaN); side = market.marketType === 'spot' ? row.side : num(row.size) == null || num(row.size) === 0 ? null : Number(row.size) > 0 ? 'buy' : 'sell'; time = row.create_time_ms ?? row.create_time; break;
    case 'kucoin': id = row.tradeId ?? row.sequence; price = row.price; quantity = row.size; side = row.side; time = (num(row.ts ?? row.time) ?? NaN) / 1e6; break;
    case 'mexc': id = row.id; price = row.price; quantity = row.qty; side = typeof row.isBuyerMaker === 'boolean' ? row.isBuyerMaker ? 'sell' : 'buy' : null; time = row.time; break;
    case 'aster': id = row.a; price = row.p; quantity = row.q; side = typeof row.m === 'boolean' ? (row.m ? 'sell' : 'buy') : null; time = row.T; break;
  }
  const p = num(price), q = num(quantity), rawTime = num(time); const s = String(side).toLowerCase();
  // Gate futures REST timestamps are fractional SECONDS while its WebSocket feed uses ms, so
  // every venue timestamp is normalised to ms before validation. Anything below 1e11 can only
  // be a seconds value; above it is already milliseconds.
  const t = rawTime == null ? null : rawTime < 1e11 ? rawTime * 1000 : rawTime;
  // All accepted markets are USDT-quoted. Missing multiplier, ID, taker side or timestamp is a hard rejection.
  if (market.quote !== 'USDT' || id == null || String(id) === '' || (typeof id === 'number' && !Number.isSafeInteger(id)) || !p || p <= 0 || !q || q <= 0 || t == null || t < 1e12 || t > Date.now() + 60_000 || !['buy', 'sell'].includes(s) || multiplier == null || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  const base = q * multiplier;
  if (!Number.isFinite(base) || !Number.isFinite(p * base)) return null;
  return { id: String(id), exchange: market.exchange, marketType: market.marketType, symbol: market.symbol, price: p, quantity: base, notional: p * base, side: s as 'buy' | 'sell', time: Math.floor(t), source };
}

export function orderFlowCapability(market: ProjectMarket) {
  // CCXT venues expose quotes only; there is no verified aggressor tape to bucket.
  if ((CCXT_EXCHANGE_IDS as readonly string[]).includes(market.exchange)) return { available: false, reason: 'CCXT venue: snapshot quotes only, no verified aggressor trade tape.' };
  if(market.exchange==='upbit'||market.exchange==='bithumb')return {available:false,reason:'KRW spot REST only; excluded from USDT aggressor flow.'};
  if (market.quote !== 'USDT') return { available: false, reason: 'Only USDT pairs are comparable; no unverified FX conversion.' };
  if (market.exchange === 'mexc' && market.marketType === 'perpetual') return { available: false, reason: 'MEXC public deal feed has no documented stable event ID; reliable deduplication not verified. Flow excluded.' };
  // Live MEXC spot /api/v3/trades returns id:null on every row (verified 2026-10-28); without a
  // stable native id REST/WebSocket overlap cannot be deduplicated, so flow is explicitly excluded.
  if (market.exchange === 'mexc' && market.marketType === 'spot') return { available: false, reason: 'MEXC spot public trades expose no stable trade ID; deduplicated flow cannot be verified. Flow excluded.' };
  return { available: true, reason: 'Public aggressor trades; bounded REST recovery + WebSocket.' };
}

export async function verifiedFlowInstrument(market: ProjectMarket): Promise<Instrument> {
  const instrument = (await getExchangeInstruments(market.exchange)).find(i => i.marketType === market.marketType && i.nativeSymbol === market.symbol && i.base === market.base && i.quote === market.quote);
  if (!instrument) throw new Error('Selected market is absent from verified exchange catalog');
  if (['okx', 'gate', 'kucoin'].includes(market.exchange) && market.marketType === 'perpetual' && !(instrument.contractMultiplier && instrument.contractMultiplier > 0)) throw new Error('Contract multiplier unavailable; excluded from flow');
  return instrument;
}
export async function recentFlowTrades(market: ProjectMarket, instrument: Instrument): Promise<FlowTrade[]> {
  if(market.exchange==='upbit'||market.exchange==='bithumb')throw new Error('KRW spot does not support this USDT flow adapter');
  const symbol = encodeURIComponent(market.symbol), spot = market.marketType === 'spot';
  const urls: Partial<Record<ProjectMarket['exchange'], string>> = {
    binance: spot ? `https://api.binance.com/api/v3/aggTrades?symbol=${symbol}&limit=1000` : `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`,
    bybit: `https://api.bybit.com/v5/market/recent-trade?category=${spot ? 'spot' : 'linear'}&symbol=${symbol}&limit=${spot ? 60 : 1000}`,
    okx: `https://www.okx.com/api/v5/market/trades?instId=${symbol}&limit=500`,
    bitget: spot ? `https://api.bitget.com/api/v2/spot/market/fills?symbol=${symbol}&limit=1000` : `https://api.bitget.com/api/v2/mix/market/fills?symbol=${symbol}&productType=USDT-FUTURES&limit=1000`,
    gate: spot ? `https://api.gateio.ws/api/v4/spot/trades?currency_pair=${symbol}&limit=1000` : `https://api.gateio.ws/api/v4/futures/usdt/trades?contract=${symbol}&limit=1000`,
    kucoin: spot ? `https://api.kucoin.com/api/v1/market/histories?symbol=${symbol}` : `https://api-futures.kucoin.com/api/v1/trade/history?symbol=${symbol}`,
    mexc: `https://api.mexc.com/api/v3/trades?symbol=${symbol}&limit=1000`,
    aster: `https://fapi.asterdex.com/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`,
  };
  const url = urls[market.exchange];
  // CCXT-only venues expose snapshots but no normalised trade tape; fail explicitly.
  if (!url) throw new Error(`${market.exchange} has no native trade-tape adapter`);
  if (!venueBreakers.allow(market.exchange, 'flow')) throw new Error(`${market.exchange} trade tape is in an open-circuit cooldown`);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${market.exchange} recent trades HTTP ${response.status}`);
    venueBreakers.success(market.exchange, 'flow');
  } catch (error) {
    venueBreakers.failure(market.exchange, error instanceof Error ? error.message : 'flow failed', 'flow');
    throw error;
  }
  if (!response.ok) throw new Error(`${market.exchange} recent trades HTTP ${response.status}`);
  const raw = await response.json();
  if (market.exchange === 'bybit' && raw.retCode !== 0) throw new Error(`Bybit ${raw.retCode}`);
  if (market.exchange === 'bitget' && raw.code !== '00000') throw new Error(`Bitget ${raw.code}`);
  if (market.exchange === 'okx' && raw.code !== '0') throw new Error(`OKX ${raw.code}`);
  if (market.exchange === 'kucoin' && raw.code !== '200000') throw new Error(`KuCoin ${raw.code}`);
  const data = market.exchange === 'bybit' ? raw.result?.list : Array.isArray(raw) ? raw : raw.data;
  const multiplier = !spot && ['okx', 'gate', 'kucoin'].includes(market.exchange) ? instrument.contractMultiplier ?? null : 1;
  const result = rows(data).flatMap(row => { const trade = normalizeFlowTrade(market, row, multiplier); return trade ? [trade] : []; });
  if (rows(data).length && !result.length) throw new Error('Trade payload rejected: no verified ID/side/size/timestamp');
  return result.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

/** Shared shape builder so every venue uses identical side/quantity conventions. */
function liquidationEvent(exchange: LiquidationEvent['exchange'], symbol: string, time: number, orderSide: 'buy' | 'sell', price: number, quantity: number): LiquidationEvent | null {
  const base = Math.abs(quantity);
  if (!Number.isFinite(time) || time < 1e12 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(base) || base <= 0) return null;
  return {
    id: `${exchange}:${symbol}:${time}:${orderSide}:${base}:${price}`,
    exchange,
    symbol,
    time: Math.floor(time),
    orderSide,
    // A BUY liquidation order closes a short position; a SELL order closes a long.
    liquidatedSide: orderSide === 'buy' ? 'short' : 'long',
    price,
    quantity: base,
    notional: price * base,
  };
}

/**
 * Binance forceOrder snapshot: one symbol per message, `S` is the liquidation order side.
 */
export function normalizeLiquidation(message: Row, symbol: string): LiquidationEvent | null {
  const order = message.o as Row | undefined;
  if (message.e !== 'forceOrder' || !order || order.s !== symbol || !['BUY', 'SELL'].includes(String(order.S))) return null;
  const price = num(order.ap), quantity = num(order.z), time = num(order.T);
  if (!price || price <= 0 || !quantity || quantity <= 0 || !time) return null;
  return liquidationEvent('binance', symbol, time, order.S === 'BUY' ? 'buy' : 'sell', price, quantity);
}

/**
 * Bybit v5 `allLiquidation.<symbol>`: the payload may carry several symbols; `v` is the
 * position size in base coin for linear contracts.
 */
export function normalizeBybitLiquidation(message: Row, symbol: string): LiquidationEvent | null {
  if (!String(message.topic ?? '').startsWith('allLiquidation.')) return null;
  const rows = Array.isArray(message.data) ? message.data as Row[] : [];
  const row = rows.find((entry) => String(entry.s) === symbol);
  if (!row) return null;
  const side = String(row.S ?? '').toLowerCase();
  const price = num(row.p), quantity = num(row.v), time = num(row.T);
  if (!['buy', 'sell'].includes(side) || price == null || quantity == null || time == null) return null;
  return liquidationEvent('bybit', symbol, time, side as 'buy' | 'sell', price, quantity);
}

/**
 * OKX `liquidation-orders`: per-instId details; `sz` is contracts and is normalised with
 * the instrument multiplier by the caller. `posSide` is authoritative when present.
 */
export function normalizeOkxLiquidation(message: Row, symbol: string, multiplier = 1): LiquidationEvent | null {
  const arg = message.arg as Row | undefined;
  if (String(arg?.channel ?? '') !== 'liquidation-orders') return null;
  const rows = Array.isArray(message.data) ? message.data as Row[] : [];
  const row = rows.find((entry) => String(entry.instId) === symbol);
  if (!row) return null;
  const details = Array.isArray(row.details) ? row.details as Row[] : [];
  const detail = details[0];
  if (!detail) return null;
  const posSide = String(detail.posSide ?? '').toLowerCase();
  const side = String(detail.side ?? '').toLowerCase();
  const orderSide: 'buy' | 'sell' | null = posSide === 'long' ? 'sell' : posSide === 'short' ? 'buy' : side === 'buy' ? 'buy' : side === 'sell' ? 'sell' : null;
  const price = num(detail.bkPx), contracts = num(detail.sz), time = num(detail.ts);
  if (!orderSide || price == null || contracts == null || time == null) return null;
  return liquidationEvent('okx', symbol, time, orderSide, price, contracts * multiplier);
}

/**
 * Gate `futures.liquidates`: `size` is the liquidated position in contracts and is signed
 * (positive long, negative short). Gate timestamps are seconds.
 */
export function normalizeGateLiquidation(message: Row, symbol: string, multiplier = 1): LiquidationEvent | null {
  if (message.channel !== 'futures.liquidates' || message.event !== 'update') return null;
  const row = message.result as Row | undefined;
  if (!row || String(row.contract) !== symbol) return null;
  const size = num(row.size), price = num(row.liq_price ?? row.price), rawTime = num(row.time);
  if (size == null || size === 0 || price == null || rawTime == null) return null;
  const time = rawTime < 1e11 ? rawTime * 1000 : rawTime;
  return liquidationEvent('gate', symbol, time, size > 0 ? 'sell' : 'buy', price, Math.abs(size) * multiplier);
}

// Dedicated spot subscription; perpetuals reuse the existing multiplexed exchange stream.
export function openFlowStream(market: ProjectMarket, instrument: Instrument, onTrade: (trade: FlowTrade) => void, onState: (state: string, detail?: string) => void, onLiquidation: (event: LiquidationEvent) => void, onLiquidationState: (state: string) => void = () => {}) {
  if (market.exchange === 'aster') { onState('partial', 'REST-only: Aster has no verified public WebSocket adapter; trades are polled'); return () => {}; }
  if (market.marketType === 'perpetual') {
    const stop = openExchangeStream(market.exchange, market.symbol, raw => {
      const wrapper = raw as Row, data = (wrapper.data ?? wrapper) as Row;
      if (market.exchange === 'binance' && data.e === 'aggTrade') { const trade = normalizeFlowTrade(market, data, 1, 'websocket'); if (trade) onTrade(trade); }
      else if (data.kind === 'trade') {
        const p = num(data.price), q = num(data.quantity), t = num(data.time), side = String(data.side).toLowerCase();
        if (data.id != null && p && p > 0 && q && q > 0 && t && ['buy', 'sell'].includes(side)) onTrade({ id: String(data.id), exchange: market.exchange, marketType: 'perpetual', symbol: market.symbol, price: p, quantity: q, notional: p * q, side: side as 'buy' | 'sell', time: Math.floor(t), source: 'websocket' });
      }
    }, onState);
    const multiplier = instrument.contractMultiplier ?? 1;
    const emit = (event: LiquidationEvent | null) => { if (event) onLiquidation(event); };
    const stopLiquidation = (() => {
      switch (market.exchange) {
        case 'binance':
          return jsonSocket(`wss://fstream.binance.com/ws/${market.symbol.toLowerCase()}@forceOrder`, [], undefined, message => emit(normalizeLiquidation(message, market.symbol)), onLiquidationState);
        case 'bybit':
          return jsonSocket('wss://stream.bybit.com/v5/public/linear', [{ op: 'subscribe', args: [`allLiquidation.${market.symbol}`] }], { op: 'ping' }, message => emit(normalizeBybitLiquidation(message, market.symbol)), onLiquidationState);
        case 'okx':
          // Port 443: OKX announced the retirement of 8443 for public WebSocket traffic.
          return jsonSocket('wss://ws.okx.com:443/ws/v5/public', [{ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }], 'ping', message => emit(normalizeOkxLiquidation(message, market.symbol, multiplier)), onLiquidationState);
        default:
          // Gate's futures.liquidates channel requires credentials (verified 2026-11-07:
          // "authentication required"), so it stays unavailable rather than half-wired.
          return () => {};
      }
    })();
    return () => { stop(); stopLiquidation(); };
  }
  if (instrument.marketType !== 'spot') { onState('stale', 'Spot instrument required'); return () => {}; }
  return openSpotFlowStream(market, onTrade, onState);
}

export function openSpotFlowStream(market: ProjectMarket, onTrade: (trade: FlowTrade) => void, onState: (state: string, detail?: string) => void) {
  const capability = orderFlowCapability(market);
  if (market.marketType !== 'spot' || !capability.available || market.exchange === 'aster') {
    onState('partial', !capability.available ? capability.reason : 'No verified spot WebSocket adapter');
    return () => {};
  }
  let stopped = false; let stopSocket: (() => void) | undefined;
  const setup = async () => {
    const symbol = market.symbol;
    let url: string, messages: unknown[], ping: unknown;
    switch (market.exchange) {
      case 'binance': url = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@aggTrade`; messages = []; break;
      case 'bybit': url = 'wss://stream.bybit.com/v5/public/spot'; messages = [{ op: 'subscribe', args: [`publicTrade.${symbol}`] }]; ping = { op: 'ping' }; break;
      case 'okx': url = 'wss://ws.okx.com:443/ws/v5/public'; messages = [{ op: 'subscribe', args: [{ channel: 'trades', instId: symbol }] }]; ping = 'ping'; break;
      case 'bitget': url = 'wss://ws.bitget.com/v2/ws/public'; messages = [{ op: 'subscribe', args: [{ instType: 'SPOT', channel: 'trade', instId: symbol }] }]; ping = 'ping'; break;
      case 'gate': url = 'wss://api.gateio.ws/ws/v4/'; messages = [{ time: Math.floor(Date.now() / 1000), channel: 'spot.trades', event: 'subscribe', payload: [symbol] }]; break;
      case 'kucoin': {
        const response = await fetch('https://api.kucoin.com/api/v1/bullet-public', { method: 'POST', signal: AbortSignal.timeout(10_000) });
        const raw = await response.json(); const endpoint = raw.data?.instanceServers?.[0]?.endpoint, token = raw.data?.token;
        if (!response.ok || !endpoint || !token || !String(endpoint).startsWith('wss://')) throw new Error('KuCoin public spot token unavailable');
        url = `${endpoint}?token=${encodeURIComponent(token)}&connectId=${Date.now()}`; messages = [{ id: String(Date.now()), type: 'subscribe', topic: `/market/match:${symbol}`, privateChannel: false, response: true }]; ping = { id: String(Date.now()), type: 'ping' }; break;
      }
      default: throw new Error('No verified spot WebSocket adapter');
    }
    if (stopped) return;
    stopSocket = jsonSocket(url, messages, ping, message => {
      let list: Row[];
      if (market.exchange === 'binance') list = message.e === 'aggTrade' ? [message] : [];
      else if (market.exchange === 'gate') list = message.channel === 'spot.trades' && message.event === 'update' ? [message.result as Row] : [];
      else if (market.exchange === 'kucoin') list = String(message.topic).startsWith('/market/match:') ? [message.data as Row] : [];
      else list = rows(message.data);
      for (const row of list) { const trade = normalizeFlowTrade(market, row, 1, 'websocket'); if (trade) onTrade(trade); }
    }, onState);
  };
  void setup().catch(error => { if (!stopped) onState('stale', String(error)); });
  return () => { stopped = true; stopSocket?.(); };
}

function jsonSocket(url: string, subscriptions: unknown[], ping: unknown, onMessage: (message: Row) => void, onState: (state: string, detail?: string) => void) {
  let stopped = false, socket: WebSocket | undefined, reconnect: NodeJS.Timeout | undefined, heartbeat: NodeJS.Timeout | undefined, backoff = 1000, lastFrame = Date.now();
  const connect = () => {
    if (stopped) return; onState('connecting'); socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    socket.on('open', () => { backoff = 1000; lastFrame = Date.now(); for (const message of subscriptions) socket?.send(JSON.stringify(message)); onState('partial', 'Socket open; waiting for verified trade frames');
      heartbeat = setInterval(() => { if (socket?.readyState !== WebSocket.OPEN) return; if (ping) socket.send(typeof ping === 'string' ? ping : JSON.stringify(ping)); else socket.ping(); if (Date.now() - lastFrame > 60_000) { onState('stale', 'No upstream frames for 60s'); socket.terminate(); } }, 18_000); });
    socket.on('pong', () => { lastFrame = Date.now(); });
    socket.on('message', raw => { lastFrame = Date.now(); if (raw.toString() === 'pong') return; try { onMessage(JSON.parse(raw.toString())); } catch { onState('partial', 'Invalid upstream frame'); } });
    socket.on('error', error => onState('stale', error.message));
    socket.on('close', () => { if (heartbeat) clearInterval(heartbeat); if (stopped) return; onState('stale', 'Reconnecting; REST recovery will verify overlap'); reconnect = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30_000); });
  };
  connect(); return () => { stopped = true; if (reconnect) clearTimeout(reconnect); if (heartbeat) clearInterval(heartbeat); socket?.close(); };
}
