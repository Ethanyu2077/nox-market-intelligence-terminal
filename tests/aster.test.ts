import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { getInstruments, marketSeries, overview, type AsterTransport } from '../server/aster.ts';
import { openExchangeStream } from '../server/exchange-streams.ts';
import { openFlowStream } from '../server/orderflow-adapters.ts';
import { parseLiveEvent } from '../server/live-hub.ts';
import type { ProjectMarket } from '../shared/types.ts';

const symbol = {
  symbol: 'BTCUSDT', pair: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING',
  baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
  filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }],
};

const routes: Record<string, unknown> = {
  '/fapi/v1/exchangeInfo': { symbols: [symbol, { ...symbol, symbol: 'USD1USDT', quoteAsset: 'USD1' }, { ...symbol, symbol: 'OLDUSDT', status: 'SETTLING' }] },
  '/fapi/v1/ticker/24hr?symbol=BTCUSDT': { symbol: 'BTCUSDT', lastPrice: '76164.5', priceChangePercent: '0.100', volume: '4650.832', quoteVolume: '352329814.04', closeTime: 1_794_042_920_700 },
  '/fapi/v1/premiumIndex?symbol=BTCUSDT': { symbol: 'BTCUSDT', markPrice: '76164.50000000', lastFundingRate: '0.00003070', nextFundingTime: 1_794_067_200_000, time: 1_794_042_934_000 },
  '/fapi/v1/openInterest?symbol=BTCUSDT': { symbol: 'BTCUSDT', openInterest: '6325.243', time: 1_794_042_631_454 },
  '/fapi/v1/ticker/bookTicker?symbol=BTCUSDT': { symbol: 'BTCUSDT', bidPrice: '76124.5', askPrice: '76124.6' },
  '/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1000': [
    { a: 1, p: '76164.5', q: '0.031', T: 1_794_042_920_700, m: false },
    { a: 2, p: '76164.5', q: '0.010', T: 1_794_042_926_000, m: true },
  ],
  '/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=2': [
    [1_794_042_600_000, '76120.8', '76164.6', '76113.0', '76164.5', '0.973', 1_794_042_899_999, '74083.77'],
    [1_794_042_900_000, '76164.6', '76164.6', '76164.5', '76164.5', '0.094', 1_794_043_199_999, '7159.46'],
  ],
};

const transport: AsterTransport = async (url) => {
  const path = new URL(url).pathname + (new URL(url).search || '');
  const body = routes[path];
  if (body == null) return new Response(JSON.stringify({ code: 'NOT_FOUND', msg: path }), { status: 404 });
  return new Response(JSON.stringify(body), { status: 200 });
};

test('Aster instruments keep only trading USDT perpetuals', async () => {
  const rows = await getInstruments(transport);
  assert.deepEqual(rows.map((row) => row.nativeSymbol), ['BTCUSDT']);
  assert.equal(rows[0].id, 'aster:perpetual:BTCUSDT');
  assert.equal(rows[0].venue, 'aster');
  assert.equal(rows[0].tickSize, 0.1);
  assert.equal(rows[0].stepSize, 0.001);
});

test('Aster overview maps price, mark, funding, OI and top of book', async () => {
  const row = await overview('BTCUSDT', transport);
  assert.equal(row.price, 76164.5);
  assert.equal(row.markPrice, 76164.5);
  assert.equal(row.oiBase, 6325.243);
  assert.ok(row.oiUsd != null && row.oiUsd > 0);
  assert.equal(row.fundingRate, 0.0000307);
  assert.equal(row.nextFundingTime, 1_794_067_200_000);
  assert.equal(row.bid, 76124.5);
  assert.equal(row.ask, 76124.6);
  assert.equal(row.quality, 'live');
  assert.equal(row.cvdWindowDelta, 0.031 * 76164.5 - 0.01 * 76164.5);
});

test('Aster series returns candles and flow but never invents OI history', async () => {
  const series = await marketSeries('BTCUSDT', '5m', 2, transport);
  assert.equal(series.candles.length, 2);
  assert.deepEqual(series.oiBase, []);
  assert.deepEqual(series.oiUsd, []);
  assert.ok(series.cvd.length >= 1);
  assert.equal(series.coverage.tradeCount, 2);
  assert.equal(series.lastTradeId, 2);
  assert.match(series.coverage.oiSource, /no openInterestHist/);
  assert.equal(series.positionFlow.signals.length, 0, 'OI-dependent labels must be withheld');
  assert.match(series.source, /Aster/);
});

test('Aster watch quotes and order flow share one Aster WebSocket and use same-venue REST during a disconnect', {timeout: 6000}, async t => {
  const upstream = new WebSocketServer({port: 0, host: '127.0.0.1'});
  await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  const previous = process.env.ASTER_WS_BASE;
  process.env.ASTER_WS_BASE = 'ws://127.0.0.1:' + address.port;
  const events = new EventEmitter();
  const fallbackUrls: URL[] = [], states: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    fallbackUrls.push(new URL(url));
    return transport(url);
  });
  const connection = once(upstream, 'connection');
  const stopQuotes = openExchangeStream('aster', 'BTCUSDT', body => {
    const wrapper = body as {exchange: string; transport?: string; data: {e: string}};
    if (wrapper.transport === 'rest-fallback') events.emit('fallback-' + wrapper.data.e, wrapper);
    else events.emit(wrapper.data.e, wrapper);
  }, (state, detail) => states.push(state + ' ' + (detail ?? '')));
  const market: ProjectMarket = {id:'m', exchange:'aster', marketType:'perpetual', symbol:'BTCUSDT', base:'BTC', quote:'USDT', status:'TRADING'};
  const instrument = (await getInstruments(transport))[0];
  const stopFlow = openFlowStream(market, instrument, trade => events.emit('trade', trade), () => {}, () => {});
  t.after(() => {
    stopFlow(); stopQuotes();
    if (previous === undefined) delete process.env.ASTER_WS_BASE;
    else process.env.ASTER_WS_BASE = previous;
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
  });
  const [socket, request] = await connection;
  assert.equal(upstream.clients.size, 1);
  assert.match(request.url, /^\/stream\?streams=btcusdt@aggTrade\/.+btcusdt@ticker$/);
  const at = Date.now();
  const price = once(events, '24hrTicker'), flow = once(events, 'trade');
  socket.send(JSON.stringify({stream:'btcusdt@ticker',data:{e:'24hrTicker',s:'BTCUSDT',E:at,c:'101',P:'2.5'}}));
  socket.send(JSON.stringify({stream:'btcusdt@aggTrade',data:{e:'aggTrade',s:'BTCUSDT',a:8,p:'105',q:'2',m:true,T:at,E:at}}));
  const [[ticker], [trade]] = await Promise.all([price,flow]);
  assert.equal(ticker.exchange, 'aster');
  assert.deepEqual([parseLiveEvent(ticker, at)?.price, parseLiveEvent(ticker, at)?.change24hPct], [101, 2.5]);
  assert.deepEqual([trade.exchange, trade.price, trade.notional, trade.side, trade.source], ['aster',105,210,'sell','websocket']);
  stopFlow();
  assert.equal(upstream.clients.size, 1);
  const fallback = once(events, 'fallback-24hrTicker');
  socket.close();
  const [sample] = await fallback;
  assert.equal(sample.exchange, 'aster');
  assert.equal(sample.transport, 'rest-fallback');
  assert.equal(sample.data.c, '76164.5');
  assert.ok(states.some(state => state.startsWith('degraded') && state.includes('Aster')));
  assert.ok(fallbackUrls.length && fallbackUrls.every(u => u.host === new URL(process.env.ASTER_REST_BASE ?? 'https://fapi.asterdex.com').host));
});

test('Aster upstream failures surface as explicit errors', async () => {
  await assert.rejects(() => overview('NOPE', transport), /Aster 404/);
});
