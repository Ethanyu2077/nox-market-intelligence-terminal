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
