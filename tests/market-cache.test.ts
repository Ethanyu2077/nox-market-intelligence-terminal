import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { MarketCache } from '../server/market-cache.ts';

test('concurrent cold requests share the payload and timestamp', async (t) => {
  const cache = new MarketCache(null);
  t.after(() => cache.close());
  let calls = 0;
  const load = async () => { calls += 1; return { n: calls }; };
  const [a, b] = await Promise.all([cache.get('k', { ttlMs: 1_000, load }), cache.get('k', { ttlMs: 1_000, load })]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test('active keys refresh on the server clock and idle keys stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cache = new MarketCache(null, 100);
  t.after(() => cache.close());
  let calls = 0;
  const options = { ttlMs: 30, load: async () => ++calls };

  const first = await cache.get('k', options);
  t.mock.timers.tick(29);
  assert.deepEqual(await cache.get('k', options), first);
  t.mock.timers.tick(1);
  const duringRefresh = await cache.get('k', options);
  assert.equal(duringRefresh.value, first.value);
  assert.equal(duringRefresh.stale, true);
  await setImmediate();
  assert.equal((await cache.get('k', options)).value, 2);
  t.mock.timers.tick(110);
  assert.equal(calls, 2);
  assert.equal((await cache.get('k', options)).value, 3);
});

test('an old on-disk snapshot remains available when its scheduled refresh fails', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-market-cache-'));
  const first = new MarketCache(dir);
  const restarted = new MarketCache(dir);
  t.after(async () => { first.close(); restarted.close(); await rm(dir, { recursive: true, force: true }); });
  const published = await first.get('k', { ttlMs: 1_000, load: async () => ({ ok: true }) });
  first.close();
  let failed!: () => void;
  const attempted = new Promise<void>(resolve => { failed = resolve; });
  const options = { ttlMs: 0, load: async () => { failed(); throw new Error('upstream down'); } };
  const stale = await restarted.get('k', options);
  await attempted;
  assert.deepEqual(stale, { ...published, stale: true });
  assert.deepEqual(await restarted.get('k', options), stale);
});
