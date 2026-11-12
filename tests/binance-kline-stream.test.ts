import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { binanceGovernor } from '../server/binance-governor.ts';
import { BinanceKlineStream, mergeCandle } from '../server/binance-kline-stream.ts';

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
