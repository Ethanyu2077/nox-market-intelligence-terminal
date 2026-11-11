import assert from 'node:assert/strict';
import test from 'node:test';
import { LIVE_CHANNELS, parseLiveEvent } from '../server/live-hub.ts';

test('live ticker parsing keeps only real numeric fields', () => {
  assert.deepEqual(parseLiveEvent({ data: { c: '1.5', P: '-2.5', r: '0.0001' } }, 10), { price: 1.5, change24hPct: -2.5, fundingRate: 0.0001, at: 10, stale: false });
  assert.equal(parseLiveEvent({ data: { e: 'depthUpdate' } }, 10), null);
  assert.equal(parseLiveEvent(null, 10), null);
});

test('channels are explicitly separated', () => {
  assert.deepEqual(LIVE_CHANNELS, ['quotes', 'flow', 'edge', 'depth']);
});

test('price updates consume last trades and normalized venue quotes on their own timestamps', () => {
  const trade = parseLiveEvent({ data: { e: 'aggTrade', p: '99.1', E: 2050, T: 2020 } }, 2100);
  assert.equal(trade?.price, 99.1);
  assert.equal(trade?.at, 2020);
  const ticker = parseLiveEvent({ data: { kind: 'ticker', price: 101, eventTime: 2030, change24hPct: 2 } }, 2100);
  assert.equal(ticker?.price, 101);
  assert.equal(ticker?.change24hPct, 2);
  assert.equal(ticker?.at, 2030);
  const funding = parseLiveEvent({ data: { e: 'markPriceUpdate', E: 2050, p: '102', r: '0' } }, 2100);
  assert.equal(funding?.price, null);
  assert.equal(funding?.fundingRate, 0);
  assert.equal(parseLiveEvent({ data: { price: null, change24hPct: null } }, 2100), null);
  assert.equal(parseLiveEvent({ data: { price: 0 } }, 2100), null);
});
