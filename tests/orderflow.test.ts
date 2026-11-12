import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOW_INTERVALS, type FlowTrade, type FlowVenue } from '../shared/orderflow.ts';
import { aggregateFlow, clusterFlowTrades, flowBuckets, flowDivergences, robustZ, timeGrid, tradeSizeRatio } from '../server/orderflow-calculations.ts';
import { normalizeFlowTrade, normalizeLiquidation, orderFlowCapability } from '../server/orderflow-adapters.ts';
import { DEFAULT_FLOW_LAYOUT, isFlowLayout } from '../shared/flow-layout.ts';
import { OrderFlowService } from '../server/orderflow-service.ts';
import type { MarketProject, ProjectMarket } from '../shared/types.ts';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const now = 1_790_000_040_000;
const market: ProjectMarket = { id: 'binance:spot:TESTUSDT', exchange: 'binance', symbol: 'TESTUSDT', base: 'TEST', quote: 'USDT', marketType: 'spot', status: 'TRADING' };
const trade = (values: Partial<FlowTrade> = {}): FlowTrade => ({ id: '1', exchange: 'binance', symbol: 'TESTUSDT', marketType: 'spot', price: 2, quantity: 10, notional: 20, side: 'buy', time: now, source: 'rest', ...values });

test('maker-side Binance flags invert to aggressor-side and never treat null as sell', () => {
  assert.equal(normalizeFlowTrade(market, { a: 1, p: '2', q: '10', m: true, T: now }, 1)?.side, 'sell');
  assert.equal(normalizeFlowTrade(market, { a: 1, p: '2', q: '10', m: false, T: now }, 1)?.notional, 20);
  assert.equal(normalizeFlowTrade(market, { a: 1, p: '2', q: '10', m: null, T: now }, 1), null);
  assert.equal(normalizeFlowTrade(market, { p: '2', q: '10', m: false, T: now }, 1), null);
});
test('OKX, Gate and KuCoin contract quantities use multipliers before notional', () => {
  const okx = normalizeFlowTrade({ ...market, exchange: 'okx', marketType: 'perpetual' }, { tradeId: 'a', px: '50', sz: '100', side: 'sell', ts: now }, .01)!;
  assert.equal(okx.quantity, 1); assert.equal(okx.notional, 50);
  const gate = normalizeFlowTrade({ ...market, exchange: 'gate', marketType: 'perpetual' }, { id: 2, price: '50', size: -100, create_time_ms: now }, .01)!;
  assert.equal(gate.side, 'sell'); assert.equal(gate.quantity, 1);
  const kucoin = normalizeFlowTrade({ ...market, exchange: 'kucoin', marketType: 'perpetual' }, { tradeId: 'c', price: '50', size: 100, side: 'buy', ts: now * 1e6 }, .01)!;
  assert.equal(kucoin.time, now); assert.equal(kucoin.notional, 50);
  assert.equal(normalizeFlowTrade({ ...market, exchange: 'okx' }, { tradeId: 'a', px: '50', sz: '100', side: 'sell', ts: now }, null), null);
});
test('Gate futures REST fractional-second timestamps are normalised to milliseconds', () => {
  // Live Gate /futures/usdt/trades returns create_time_ms as fractional seconds (e.g. 1793199068.727).
  const trade = normalizeFlowTrade({ ...market, exchange: 'gate', marketType: 'perpetual' }, { id: 862161882, price: '80583.3', size: 5279, create_time_ms: 1_793_199_068.727 }, 1)!;
  assert.ok(trade, 'a verified Gate REST trade must not be rejected');
  assert.equal(trade.time, 1_793_199_068_727);
  assert.equal(trade.side, 'buy');
});
test('MEXC spot flow is excluded while public trades expose no stable trade ID', () => {
  assert.equal(orderFlowCapability({ ...market, exchange: 'mexc', marketType: 'spot' }).available, false);
});
test('Bybit, Bitget and MEXC spot preserve native ID and verified taker side', () => {
  assert.equal(normalizeFlowTrade({ ...market, exchange: 'bybit' }, { execId: '3', price: '3', size: '4', side: 'Buy', time: now }, 1)?.notional, 12);
  assert.equal(normalizeFlowTrade({ ...market, exchange: 'bitget' }, { tradeId: '4', price: '3', size: '4', side: 'sell', ts: now }, 1)?.side, 'sell');
  assert.equal(normalizeFlowTrade({ ...market, exchange: 'mexc' }, { id: '5', price: '3', qty: '4', isBuyerMaker: false, time: now }, 1)?.side, 'buy');
  assert.equal(orderFlowCapability({ ...market, exchange: 'mexc', marketType: 'perpetual' }).available, false);
  assert.equal(orderFlowCapability({ ...market, quote: 'BTC' }).available, false);
});
test('all requested intervals align event time without mixing spot and perpetual deltas', () => {
  for (const interval of Object.keys(FLOW_INTERVALS) as Array<keyof typeof FLOW_INTERVALS>) {
    const grid = timeGrid(now, interval, 3); const at = grid[1] + 100;
    const buckets = flowBuckets([trade({ time: at }), trade({ id: '2', side: 'sell', notional: 5, time: at + 1 })], interval, 'window', grid, { from: grid[0], to: grid[2], gaps: [] });
    assert.equal(buckets[1].buy, 20); assert.equal(buckets[1].sell, 5); assert.equal(buckets[1].delta, 15); assert.equal(buckets[1].cvd, 15);
    assert.equal(buckets[0].delta, 0); assert.equal(buckets[0].complete, true);
    assert.equal(buckets[2].delta, null); assert.equal(buckets[2].complete, false);
  }
});
test('CVD reset and unrecovered gaps are explicit and never interpolate unknown time', () => {
  const grid = timeGrid(now, '1m', 4);
  const buckets = flowBuckets(grid.map((time, i) => trade({ id: String(i), time: time + 100 })), '1m', 'window', grid, { from: grid[0], to: grid[3] + 60_000, gaps: [{ from: grid[1], to: grid[2], reason: 'disconnect' }] });
  assert.equal(buckets[0].cvd, 20); assert.equal(buckets[1].cvd, null); assert.equal(buckets[2].reset, true); assert.equal(buckets[2].cvd, 20);
  const hourGrid = [1_789_999_140_000, 1_789_999_200_000];
  const hour = flowBuckets(hourGrid.map((time, i) => trade({ id: String(i), time })), '1m', 'utc-hour', hourGrid, { from: hourGrid[0], to: hourGrid[1] + 60_000, gaps: [] });
  assert.equal(hour[0].cvd, 20); assert.equal(hour[1].cvd, 20);
});
test('flow buckets carry normalized base quantity per side', () => {
  const grid = timeGrid(now, '1m', 3);
  const buckets = flowBuckets([
    trade({ time: grid[1] + 100, quantity: 2, notional: 10, side: 'buy' }),
    trade({ id: '2', time: grid[1] + 200, quantity: 3, notional: 15, side: 'sell' }),
  ], '1m', 'window', grid, { from: grid[0], to: grid[2], gaps: [] });
  assert.equal(buckets[1].base, 5);
  assert.equal(buckets[1].buyBase, 2);
  assert.equal(buckets[1].sellBase, 3);
  assert.equal(buckets[0].base, 0);
});
test('flow buckets compute base-weighted VWAP, price range and largest print', () => {
  const grid = timeGrid(now, '1m', 2);
  const buckets = flowBuckets([
    trade({ time: grid[0] + 100, price: 100, quantity: 2, notional: 200, side: 'buy' }),
    trade({ id: '2', time: grid[0] + 200, price: 110, quantity: 1, notional: 110, side: 'sell' }),
  ], '1m', 'window', [grid[0]], { from: grid[0], to: grid[0] + 60_000, gaps: [] });
  assert.equal(buckets[0].vwap, 310 / 3);
  assert.equal(buckets[0].high, 110);
  assert.equal(buckets[0].low, 100);
  assert.equal(buckets[0].maxTradeNotional, 200);
});
test('aggregation requires complete aligned coverage from every selected venue', () => {
  const grid = timeGrid(now, '1m', 2);
  const buckets = flowBuckets([trade({ time: grid[0] + 1 })], '1m', 'window', grid, { from: grid[0], to: grid[1], gaps: [] });
  const good = { buckets } as FlowVenue;
  const missing = { buckets: buckets.map(b => ({ ...b, complete: false, delta: null })) } as FlowVenue;
  assert.equal(aggregateFlow([good, good], grid, '1m', 'window')[0].delta, 40);
  assert.equal(aggregateFlow([good, missing], grid, '1m', 'window')[0].delta, null);
  assert.equal(aggregateFlow([], grid, '1m', 'window')[0].cvd, null);
});
test('unusual flow requires a historical baseline and nonzero MAD', () => {
  assert.equal(robustZ(100, [1, 2]), null);
  assert.equal(robustZ(100, Array(20).fill(1)), null);
  assert.ok(robustZ(100, Array.from({ length: 25 }, (_, i) => i % 5))! > 3);
  assert.deepEqual(flowDivergences([], [], now), []);
});
test('trade size baseline uses earlier same-market records only', () => {
  assert.equal(tradeSizeRatio(trade({ time: now + 100, notional: 100 }), Array.from({ length: 20 }, (_, i) => trade({ id: String(i), time: now + i }))), 5);
  assert.equal(tradeSizeRatio(trade(), Array(30).fill(trade({ marketType: 'perpetual' }))), null);
});
test('tape clusters preserve constituent records and never mix spot/perp or aggressor sides', () => {
  const values = [trade(), trade({ id: '2', time: now + 10 }), trade({ id: '3', marketType: 'perpetual' }), trade({ id: '4', side: 'sell' }), trade()];
  const clusters = clusterFlowTrades(values);
  assert.equal(clusters.length, 3);
  const spotBuy = clusters.find(c => c.marketType === 'spot' && c.side === 'buy')!;
  assert.deepEqual(spotBuy.tradeIds, ['1', '2']); assert.equal(spotBuy.notional, 40);
  assert.equal(values.length, 5);
});
test('liquidation snapshots use filled quantity/average price and distinguish order side from liquidated side', () => {
  const event = normalizeLiquidation({ e: 'forceOrder', o: { s: 'TESTUSDT', S: 'SELL', ap: '2', z: '3', q: '100', T: now } }, 'TESTUSDT')!;
  assert.equal(event.notional, 6); assert.equal(event.liquidatedSide, 'long'); assert.equal(event.orderSide, 'sell');
  assert.equal(normalizeLiquidation({ e: 'forceOrder', o: { s: 'OTHER' } }, 'TESTUSDT'), null);
});
test('workspace validation supports the advanced layout and rejects foreign/duplicate panels', () => {
  assert.equal(isFlowLayout(DEFAULT_FLOW_LAYOUT), true);
  assert.equal(isFlowLayout({ type: 'split', direction: 'row', children: ['price', 'price'] }), false);
  assert.equal(isFlowLayout('execution'), false);
});
test('idle snapshot has unavailable metrics, no unsolicited data collection and no default tokens', () => {
  const service = new OrderFlowService('/private/tmp/nox-orderflow-idle-test');
  const project = { id: 'test', markets: [market], monitoring: { streamingEnabled: false, defaultInterval: '1m' } } as MarketProject;
  const response = service.snapshot(project, '1m', 'window', now);
  assert.equal(response.trades.length, 0); assert.equal(response.aggregates.spot.buckets.at(-1)?.delta, null);
  assert.equal(response.venues[0].market.symbol, 'TESTUSDT'); assert.equal(response.aggregates.perpetual.requested, 0);
});

test('shared collection deduplicates REST/WebSocket trades, separates types, and persists raw records', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-flow-test-'));
  let connections = 0, verifies = 0; const callbacks = new Map<string, (t: FlowTrade) => void>();
  const current = Date.now();
  const project = { id: 'test', markets: [market, { ...market, id: 'perp', marketType: 'perpetual' }], monitoring: { streamingEnabled: true, defaultInterval: '1m' } } as MarketProject;
  const dependencies = {
    verify: async (m: ProjectMarket) => { verifies++; return { ...m, venue: m.exchange, nativeSymbol: m.symbol, settlement: 'USDT', contractType: '', tickSize: 0, stepSize: 0 }; },
    recent: async (m: ProjectMarket) => [trade({ id: 'same-native-id', marketType: m.marketType, time: current - 1000 })],
    stream: (m: ProjectMarket, _i: unknown, callback: (t: FlowTrade) => void) => { connections++; callbacks.set(m.marketType, callback); return () => {}; },
  };
  const service = new OrderFlowService(directory, dependencies);
  const release1 = service.acquire(project), release2 = service.acquire(project);
  try {
    for (let i = 0; i < 20 && connections < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(connections, 2); assert.equal(verifies, 2);
    callbacks.get('spot')!(trade({ id: 'same-native-id', time: current - 1000, source: 'websocket' }));
    callbacks.get('spot')!(trade({ id: 'new', time: current, source: 'websocket' }));
    callbacks.get('perpetual')!(trade({ id: 'foreign-spot', marketType: 'spot', time: current, source: 'websocket' }));
    const snapshot = service.snapshot(project, '1m', 'window', current + 1);
    assert.equal(snapshot.trades.length, 3); assert.equal(snapshot.venues.find(v => v.market.marketType === 'spot')?.retainedTrades, 2);
    assert.equal(snapshot.venues.find(v => v.market.marketType === 'perpetual')?.retainedTrades, 1);
    release1(); release2(); await service.close();
    const checkpoints = path.join(directory, 'orderflow');
    const files = await readdir(checkpoints);
    assert.equal(files.length, 2);
    const identities = () => Promise.all(files.map(async file => (await stat(path.join(checkpoints, file))).ino));
    const saved = await identities();
    const restored = new OrderFlowService(directory, dependencies); restored.acquire(project);
    try {
      for (let i = 0; i < 20 && connections < 4; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(restored.snapshot(project, '1m', 'window', current + 1).trades.length, 3);
    } finally { await restored.close(); }
    // Repeated REST overlap and a graceful close leave the existing checkpoints untouched.
    assert.deepEqual(await identities(), saved);
  } finally { await service.close(); await rm(directory, { recursive: true }); }
});
