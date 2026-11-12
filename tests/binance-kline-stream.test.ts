import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { binanceGovernor } from '../server/binance-governor.ts';
import { BinanceKlineStream, mergeCandle } from '../server/binance-kline-stream.ts';
import { withMinuteCloses } from '../server/watch-overview.ts';
import type { WatchRow } from '../shared/watch-overview.ts';

class Socket extends EventEmitter {
  terminated = false;
  terminate() { this.terminated = true; this.emit('close'); }
}
const end = 600_000;
const raw = [[300_000, 0, 0, 0, '10', 0, end - 1, '20']];

test('closed candles replace by time, stay ordered and capped', () => {
  const base = [{ time: 100, close: 1, volume: 10 }, { time: 200, close: 2, volume: 20 }];
  const merged = mergeCandle(base, { time: 200, close: 3, volume: 30 });
  assert.deepEqual(merged.map((candle) => candle.close), [1, 3]);
  const later = mergeCandle(merged, { time: 300, close: 4, volume: 40 });
  assert.equal(later.at(-1)?.time, 300);
});

test('minute seeds and incremental closes use the same actual close time and exclude future candles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = t.mock.method(binanceGovernor, 'json', async () => [
    [480_000, 0, 0, 0, '3', 0, 539_999, '10'], [540_000, 0, 0, 0, '4', 0, 599_999, '20'],
    [600_000, 0, 0, 0, '5', 0, 659_999, '15'],
  ]);
  const socket = new Socket(), stream = new BinanceKlineStream(() => socket);
  const seed = await stream.get('PAIR', '1m', 61, end);
  assert.deepEqual(seed.map(c => [c.time, c.close]), [[540_000, 3], [600_000, 4]]);
  // Re-selecting a short interval on a newly listed market does not re-bootstrap.
  await stream.get('PAIR', '1m', 61, end);
  assert.equal(fetch.mock.callCount(), 1);
  socket.emit('message', JSON.stringify({ k: { t: end, c: '7', q: '10', x: false } }));
  socket.emit('message', JSON.stringify({ k: { t: end, c: '8', q: '10', x: true } }));
  assert.equal((await stream.get('PAIR', '1m', 2, end)).at(-1)?.time, end);
  assert.deepEqual((await stream.get('PAIR', '1m', 2, end + 60_000)).at(-1), { time: 660_000, close: 8, volume: 10 });
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(600_000);
});

test('minute details share a benchmark subscription, respect the market, and leave the cached overview untouched', async () => {
  const row: WatchRow = { projectId: 'btc', symbol: 'BTCUSDT', venue: 'binance', marketType: 'perpetual', quote: 'USDT', candles: [], error: null };
  const spot = { ...row, projectId: 'spot', marketType: 'spot' };
  const unselected = { ...row, projectId: 'other', symbol: 'OTHERUSDT' };
  const overview = { asOf: end, end, rows: [row, spot, unselected], benchmarks: [{ ...row, projectId: 'BTCUSDT' }, { ...row, projectId: 'ETHUSDT', symbol: 'ETHUSDT' }] };
  const requested: string[] = [];
  const enriched = await withMinuteCloses(overview, ['btc', 'spot'], 'BTCUSDT', 15, { get: async (symbol, interval, limit, at) => {
    requested.push(symbol);
    assert.deepEqual([interval, limit, at], ['1m', 16, end]);
    return [{ time: end, close: 7, volume: 1 }];
  } }, end + 55_000);
  assert.deepEqual(requested, ['BTCUSDT']);
  assert.deepEqual(enriched.rows[0].minuteCloses, [{ time: end, close: 7 }]);
  assert.deepEqual(enriched.benchmarks[0].minuteCloses, enriched.rows[0].minuteCloses);
  assert.equal(enriched.rows[1], spot);
  assert.equal(enriched.rows[2], unselected);
  assert.equal(enriched.benchmarks[1], overview.benchmarks[1]);
  assert.equal(overview.rows[0].minuteCloses, undefined);
});

test('long absolute windows and already-covered short windows use no additional upstream subscriptions', async () => {
  const row: WatchRow = { projectId: 'btc', symbol: 'BTCUSDT', venue: 'binance', marketType: 'perpetual', quote: 'USDT', candles: [], error: null,
    priceHistory: Array.from({ length: 5 }, (_, i) => ({ t: end - i * 60_000, p: 10 })) };
  const overview = { asOf: end, end, rows: [row], benchmarks: [] };
  let requests = 0;
  const stream = { get: async () => { requests++; return []; } };
  assert.equal(await withMinuteCloses(overview, [], undefined, 240, stream, end), overview);
  assert.equal(await withMinuteCloses(overview, [], undefined, 5, stream, end), overview);
  assert.equal(requests, 0);
});

test('short windows seed only four visible markets and long relative windows seed only their benchmark', async () => {
  const row = (id: string): WatchRow => ({ projectId: id, symbol: id, venue: 'binance', marketType: 'perpetual', quote: 'USDT', candles: [], error: null });
  const overview = { asOf: end, end, rows: ['A', 'B', 'C', 'D', 'E'].map(row), benchmarks: ['ETHUSDT', 'BTCUSDT'].map(row) };
  const requests: string[] = [];
  const stream = { get: async (symbol: string) => { requests.push(symbol); return []; } };
  await withMinuteCloses(overview, ['E', 'D', 'C', 'A'], undefined, 15, stream, end);
  assert.deepEqual(requests.sort(), ['A', 'C', 'D', 'E']);
  requests.length = 0;
  await withMinuteCloses(overview, [], 'ETHUSDT', 240, stream, end);
  assert.deepEqual(requests, ['ETHUSDT']);
});

test('a slow minute bootstrap cannot block the base chart or mutate a response after its return', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const row: WatchRow = { projectId: 'x', symbol: 'X', venue: 'binance', marketType: 'perpetual', quote: 'USDT', candles: [], error: null };
  const overview = { asOf: end, end, rows: [row], benchmarks: [] };
  let finish!: (points: { time: number; close: number; volume: number }[]) => void;
  const response = withMinuteCloses(overview, [], undefined, 5, { get: () => new Promise(resolve => { finish = resolve; }) }, end);
  t.mock.timers.tick(1_200);
  const result = await response;
  assert.equal(result.rows[0], row);
  finish([{ time: end, close: 30, volume: 100 }]);
  await Promise.resolve();
  assert.equal(result.rows[0].minuteCloses, undefined);
});

test('only callers renew a kline subscription and expiry cancels pending reconnects', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: end });
  t.mock.method(binanceGovernor, 'json', async () => raw);
  const sockets: Socket[] = [];
  const streams = new BinanceKlineStream(() => { const socket = new Socket(); sockets.push(socket); return socket; });
  await streams.get('BTCUSDT', '5m', 1, end);
  await streams.get('ETHUSDT', '5m', 1, end);
  t.mock.timers.tick(599_000);
  await streams.get('BTCUSDT', '5m', 1, end);
  sockets[1].emit('close');
  t.mock.timers.tick(2_000);
  assert.deepEqual(streams.status().map(row => row.key), ['BTCUSDT:5m']);
  assert.equal(sockets.length, 2, 'the expired subscription must not reopen');
  assert.equal(sockets[0].terminated, false);
  t.mock.timers.tick(600_000);
  assert.deepEqual(streams.status(), []);
  assert.equal(sockets[0].terminated, true);
  t.mock.timers.tick(30_000);
  assert.equal(sockets.length, 2);
});

test('a delayed bootstrap can return candles but cannot reopen an expired stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let respond!: (value: typeof raw) => void;
  t.mock.method(binanceGovernor, 'json', () => new Promise(resolve => { respond = resolve; }));
  const streams = new BinanceKlineStream(() => { throw new Error('expired subscription reopened'); });
  const result = streams.get('ETHUSDT', '5m', 1, end);
  t.mock.timers.tick(600_000);
  respond(raw);
  assert.deepEqual(await result, [{ time: end, close: 10, volume: 20 }]);
  assert.deepEqual(streams.status(), []);
});

test('overflow symbols keep receiving candles without retaining a socket or entry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(binanceGovernor, 'json', async () => raw);
  let opened = 0;
  const streams = new BinanceKlineStream(() => { opened++; return new Socket(); });
  for (let i = 0; i < 135; i++) {
    const candles = await streams.get(`TOKEN${i}USDT`, '5m', 1, end);
    assert.equal(candles[0].close, 10);
  }
  assert.equal(opened, 128);
  assert.equal(streams.status().length, 128);
  t.mock.timers.tick(600_000);
  assert.deepEqual(streams.status(), []);
});
