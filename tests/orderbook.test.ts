import assert from 'node:assert/strict';
import test from 'node:test';
import { isDepthVenue, orderBookSnapshot, parseDepth } from '../server/orderbook.ts';

const payload = {
  lastUpdateId: 42,
  E: 1_700_000_000_000,
  bids: [['100', '2'], ['99.5', '1'], ['101', '0']],
  asks: [['100.5', '1'], ['101', '3']],
};

test('depth parsing sorts levels, ignores invalid sizes and computes book metrics', () => {
  const book = parseDepth('binance', 'btcusdt', payload, 1_700_000_001_000);
  assert.equal(book.symbol, 'BTCUSDT');
  assert.deepEqual(book.bids.map((level) => level.price), [100, 99.5]);
  assert.deepEqual(book.asks.map((level) => level.price), [100.5, 101]);
  assert.equal(book.bestBid, 100);
  assert.equal(book.bestAsk, 100.5);
  assert.equal(book.midPrice, 100.25);
  assert.ok(book.spreadBps != null && book.spreadBps > 0);
  assert.equal(book.bidDepthUsd, 299.5);
  assert.equal(book.askDepthUsd, 403.5);
  assert.equal(book.imbalancePct, (299.5 - 403.5) / 703 * 100);
  assert.equal(book.lastUpdateId, 42);
  assert.equal(book.quality, 'live');
});

test('an empty or malformed book reports nulls instead of zero-filled prices', () => {
  const book = parseDepth('aster', 'DOODUSDT', { bids: [], asks: 'nope' }, 1_000);
  assert.equal(book.bestBid, null);
  assert.equal(book.bestAsk, null);
  assert.equal(book.midPrice, null);
  assert.equal(book.spreadBps, null);
  assert.equal(book.imbalancePct, null);
  assert.equal(book.bidDepthUsd, 0);
});

test('a stale event time downgrades quality', () => {
  const book = parseDepth('binance', 'BTCUSDT', payload, 1_700_000_100_000);
  assert.equal(book.quality, 'stale');
});

test('only verified venues and explicit limits are accepted', async () => {
  assert.equal(isDepthVenue('binance'), true);
  assert.equal(isDepthVenue('aster'), true);
  assert.equal(isDepthVenue('bybit'), false);
  await assert.rejects(() => orderBookSnapshot('bybit', 'BTCUSDT'), /no verified depth adapter/);
});

test('snapshot fetch parses a venue response and caches it', async () => {
  let calls = 0;
  const transport = (async () => { calls += 1; return new Response(JSON.stringify(payload), { status: 200 }); }) as unknown as typeof fetch;
  const first = await orderBookSnapshot('binance', 'BTCUSDT', 5, transport);
  const second = await orderBookSnapshot('binance', 'BTCUSDT', 5, transport);
  assert.equal(first.bestBid, 100);
  assert.equal(second.lastUpdateId, 42);
  assert.equal(calls, 1, 'second call hits the shared cache');
});
