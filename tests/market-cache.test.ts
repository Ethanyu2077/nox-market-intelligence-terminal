import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

test('live REST responses ignore legacy snapshots, share in-flight requests and create no files', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-market-volatile-'));
  const legacy = new MarketCache(dir);
  const cache = new MarketCache(dir);
  t.after(async () => { legacy.close(); cache.close(); await rm(dir, { recursive: true, force: true }); });
  const key = 'watchlist:quotes';
  await legacy.get(key, { ttlMs: 60_000, load: async () => 'old quotes' });
  legacy.close();
  const [filename] = await readdir(dir);
  const original = await readFile(path.join(dir, filename), 'utf8');
  let loads = 0;
  const options = { ttlMs: 60_000, storage: 'memory' as const, load: async () => ++loads };
  const [a, b] = await Promise.all([cache.get(key, options), cache.get(key, options)]);
  assert.deepEqual(a, b);
  assert.equal(a.value, 1);
  await cache.get('venues:p', options);
  assert.deepEqual(await readdir(dir), [filename]);
  assert.equal(await readFile(path.join(dir, filename), 'utf8'), original);
});

test('a cold start after lowering the disk budget skips an oversized legacy snapshot', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-market-legacy-'));
  const first = new MarketCache(dir), restricted = new MarketCache(dir, 120_000, 4096);
  t.after(async () => { first.close(); restricted.close(); await rm(dir, { recursive: true, force: true }); });
  const key = 'overview:60';
  await first.get(key, { ttlMs: 60_000, load: async () => 'x'.repeat(10_000) });
  first.close();
  assert.equal((await restricted.get(key, { ttlMs: 60_000, load: async () => 'fresh' })).value, 'fresh');
  assert.equal(restricted.storageStatus()?.skippedWrites, 0);
  assert.ok(restricted.storageStatus()!.bytes <= 4096);
  const [file] = await readdir(dir);
  assert.equal(JSON.parse(await readFile(path.join(dir, file), 'utf8')).value, 'fresh');
});

test('warm-start checkpoints are throttled across refreshes and restarts while fresh values still advance', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-market-cadence-'));
  const first = new MarketCache(dir), restarted = new MarketCache(dir, 600_000);
  t.after(async () => { first.close(); restarted.close(); await rm(dir, { recursive: true, force: true }); });
  let count = 0;
  const options = { ttlMs: 30_000, load: async () => ++count };
  const key = 'series:ETH:1m';
  await first.get(key, options);
  first.close();
  const [name] = await readdir(dir);
  const diskValue = async () => JSON.parse(await readFile(path.join(dir, name), 'utf8')).value;
  assert.equal((await restarted.get(key, options)).value, 1);
  t.mock.timers.tick(30_000);
  await restarted['entries'].get(key)!.pending;
  assert.equal((await restarted.get(key, options)).value, 2);
  assert.equal(await diskValue(), 1);
  t.mock.timers.tick(270_000);
  await restarted['entries'].get(key)!.pending;
  assert.equal((await restarted.get(key, options)).value, 3);
  assert.equal(await diskValue(), 3);
});
