import assert from 'node:assert/strict';
import test from 'node:test';

import os from 'node:os';
import path from 'node:path';
import { MarketCache } from '../server/market-cache.ts';

const cache = () => new MarketCache(path.join(os.tmpdir(), `nox-cache-${Date.now()}-${Math.random()}`));

test('concurrent cold requests share one loader', async () => {
  const c = cache(); let calls = 0;
  const load = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { n: 1 }; };
  const [a, b] = await Promise.all([c.get('k', { ttlMs: 1000, load }), c.get('k', { ttlMs: 1000, load })]);
  assert.equal(calls, 1);
  assert.deepEqual(a.value, b.value);
});

test('stale hits return the old value immediately and refresh once', async () => {
  const c = cache(); let calls = 0;
  const load = async () => ({ n: ++calls });
  await c.get('k', { ttlMs: 0, staleMs: 60_000, load });
  const stale = await c.get('k', { ttlMs: 0, staleMs: 60_000, load });
  assert.equal(stale.stale, true);
  assert.equal(stale.value.n, 1);
  assert.equal(calls, 2);
});

test('loader failure serves the last persisted value when stale', async () => {
  const dir = path.join(os.tmpdir(), `nox-cache-fail-${Date.now()}`);
  const first = new MarketCache(dir);
  await first.get('k', { ttlMs: 1000, load: async () => ({ ok: true }) });
  const restarted = new MarketCache(dir);
  const result = await restarted.get('k', { ttlMs: 0, staleMs: 1, load: async () => { throw new Error('upstream down'); } });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.stale, true);
});
