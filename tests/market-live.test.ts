import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, {type RawData} from 'ws';
import { createLiveHub } from '../server/live-hub.ts';
import { createMarketChannel } from '../server/market-live.ts';
import { appendMarketTrades, type MarketFrame } from '../shared/market-live.ts';
import type { MarketProject, MarketSeries } from '../shared/types.ts';

function frame<T>(ws: WebSocket, type: string, id: string) {
  return new Promise<T>(resolve => {
    const read = (raw: RawData) => {
      const value = JSON.parse(raw.toString());
      if (value.id !== id || value.type !== type) return;
      ws.off('message', read); resolve(value.data);
    };
    ws.on('message', read);
  });
}

test('one real socket can subscribe, replace and release independent feeds; a paused project stops upstream', { timeout: 8000 }, async t => {
  const server = createServer();
  const market = { exchange: 'binance', marketType: 'perpetual', symbol: 'BTCUSDT' } as const;
  const project = { id: 'p', archived: false, monitoring: {streamingEnabled: true, collectionMode: 'active'}, markets: [market]} as MarketProject;
  let starts = 0, stops = 0, otherStops = 0;
  let publish: (data: unknown) => void = () => {};
  const markets = createMarketChannel(() => [project], (_venue, _symbol, data, state) => {
    starts++; publish = data; state('live'); return () => { stops++; };
  }, 15);
  const closeHub = createLiveHub(server, () => [project], { streams: {
    market: markets, another: (_params, emit) => { emit('initial'); return () => { otherStops++; }; },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const ws = new WebSocket('ws://127.0.0.1:' + addr.port + '/ws/live');
  t.after(() => { ws.terminate(); closeHub(); server.close(); });
  await once(ws, 'open');
  const listen = (id: string, channel: string, params = {}) => ws.send(JSON.stringify({op:'listen', id, channel, params}));
  const bind = frame(ws, 'listening', 'a');
  listen('a', 'market', { projectId:'p', ...market }); await bind;
  const second = frame(ws, 'listening', 'b');
  listen('b', 'market', { projectId:'p', ...market }); await second;
  assert.equal(starts, 1);
  const other = frame(ws, 'data', 'c');
  listen('c', 'another'); assert.equal(await other, 'initial');
  const first = frame<MarketFrame>(ws, 'data', 'a');
  const now = Date.now();
  for (const id of [9,9,10]) publish({data: {e:'aggTrade',s:'BTCUSDT',p:'22',q:'2',a:id,T:now,m:false}});
  publish({data:{e:'aggTrade',s:'WRONG',p:'9999',q:'1',a:12,T:now,m:false}});
  const batch = await first;
  assert.equal(batch.state, 'live'); assert.deepEqual(batch.trades, [[9,now,44],[10,now,44]]);
  assert.deepEqual(batch.quote.price, {value:22,at:now});
  const unknown = frame(ws, 'unavailable', 'c');
  listen('c','__proto__'); await unknown; assert.equal(otherStops, 1);
  ws.send(JSON.stringify({op:'unlisten', id:'a'}));
  const paused = frame(ws,'unavailable','b');
  project.monitoring.collectionMode = 'paused'; await paused;
  assert.equal(stops, 1);
});

test('REST seed and overlapping aggregate trade batches preserve OHLCV and count each print once', () => {
  const candles = [{time:0,open:5,high:7,low:4,close:6,volumeBase:1,volumeUsd:5}];
  const seed = {lastTradeId:7,eventTime:25_000,cvd:[],candles,positionFlow:{volumeFlow:[]},coverage:{tradeCount:7}} as unknown as MarketSeries;
  const live = appendMarketTrades(seed, [[7,15_000,8],[8,16_000,8],[9,61_000,-4]],60_000);
  assert.equal(live.candles, candles);
  assert.deepEqual(live.cvd.map(p=>[p.time,p.delta,p.value]),[[0,8,8],[60_000,-4,4]]);
  assert.equal(live.coverage.tradeCount,9);
  assert.equal(appendMarketTrades(live,[[9,61_000,-4]],60_000),live);
});

test('spot and perpetual viewers of the same symbol have separate live prices and replay scope', async () => {
  const spot = {id:'s',exchange:'binance',marketType:'spot',symbol:'BTCUSDT',quote:'USDT'} as const;
  const perpetual = {...spot, id:'f', marketType:'perpetual'} as const;
  const project = {id:'a', archived:false, monitoring:{streamingEnabled:true}, markets:[spot,perpetual]} as MarketProject;
  let spotTrade: (price: number) => void = () => {}, perpTrade: (price: number) => void = () => {};
  const trades = createMarketChannel(() => [project], (_venue,_symbol,onEvent,onState) => {
    onState('live');
    perpTrade = price => onEvent({data:{e:'24hrTicker',E:Date.now(),c:price}});
    return () => {};
  }, 10, (market,onTrade,onState) => {
    onState('live');
    spotTrade = price => onTrade({exchange:market.exchange,symbol:market.symbol,marketType:'spot',price,
      time:Date.now(),id:'1',quantity:2,side:'buy',notional:2*price,source:'websocket'});
    return () => {};
  });
  const frames: MarketFrame[] = [];
  const receive = (v: unknown) => {frames.push(v as MarketFrame);};
  const stop1 = trades({projectId:'a',...spot},receive,()=>assert.fail('unexpected spot failure'));
  const stop2 = trades({projectId:'a',...perpetual},receive,()=>assert.fail('unexpected perpetual failure'));
  try {
    spotTrade(121); perpTrade(125);
    await new Promise(resolve => setTimeout(resolve,30));
    assert.deepEqual(frames.map(f => [f.marketType,f.quote.price?.value]), [['spot',121],['perpetual',125]]);
  } finally { stop2(); stop1(); }
});
