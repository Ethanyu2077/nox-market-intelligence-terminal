import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SnapshotBudget } from '../server/snapshot-budget.ts';
import { MarketCache } from '../server/market-cache.ts';
import { OrderFlowCheckpoint } from '../server/orderflow-checkpoint.ts';
import { AlertService } from '../server/alert-service.ts';

const groupName = (n: number, length = 32) => n.toString(16).padStart(length, '0') + '.json';

test('blocked snapshot storage bounds queued payloads and jobs, then resumes after draining', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-slow-disk-'));
  const quota = new SnapshotBudget(dir, 'market', 128 * 1024 * 1024, () => false, 0);
  t.after(async () => { quota.close(); await rm(dir, { recursive: true, force: true }); });
  await quota.init();
  const gate = Promise.withResolvers<void>();
  quota['run'](() => gate.promise);
  const { maxPendingBytes, maxPendingWrites } = quota.status();
  const payload = 'a'.repeat(maxPendingBytes / 8);
  const key = groupName(1);
  const write = (data: string) => quota.write(key, path.join(dir, key), data);
  const pending = Array.from({ length: 8 }, () => write(payload));
  for (let i = 0; i < 1000; i++) await assert.rejects(write('x'), /queue at capacity/);
  assert.equal(quota.status().pendingBytes, maxPendingBytes);
  assert.equal(quota.status().pendingWrites, 8);
  gate.resolve();
  await Promise.all(pending);
  const small = Array.from({ length: maxPendingWrites }, () => write('x'));
  await assert.rejects(write('x'), /queue at capacity/);
  await Promise.all(small);
  assert.equal(quota.status().pendingBytes, 0);
  assert.equal(quota.status().pendingWrites, 0);
  await write('latest');
  assert.equal(await readFile(path.join(dir, key), 'utf8'), 'latest');
});

test('cache admission reserves atomic staging space and serializes concurrent writes under its aggregate budget', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-disk-cap-'));
  const block = (await statfs(dir)).bsize;
  const protectedKeys = new Set<string>();
  const quota = new SnapshotBudget(dir, 'market', 3 * block, key => protectedKeys.has(key), 0);
  t.after(async () => { quota.close(); await rm(dir, { recursive:true, force:true }); });
  const keys = Array.from({length: 24}, (_, i) => groupName(i));
  const file = (key: string) => path.join(dir, key);
  await quota.init();
  await quota.write(keys[0], file(keys[0]), 'known');
  protectedKeys.add(keys[0]);
  await Promise.all(keys.slice(1).map(key => quota.write(key, file(key), key)));
  assert.deepEqual((await readdir(dir)).sort(), [keys[0], ...keys.slice(-2)].sort());
  assert.equal(await readFile(file(keys[0]), 'utf8'), 'known');
  assert.equal(quota.status().bytes, 3 * block);
  const remaining = await readdir(dir);
  for (const name of remaining) protectedKeys.add(name);
  await assert.rejects(quota.write(keys[0], file(keys[0]), 'changed'), /quota/);
  assert.equal(await readFile(file(keys[0]), 'utf8'), 'known');
  assert.equal(quota.status().skippedWrites, 1);
  protectedKeys.delete(remaining.find(name => name !== keys[0])!);
  await quota.write(keys[0], file(keys[0]), 'changed');
  assert.equal(await readFile(file(keys[0]), 'utf8'), 'changed');
});

test('startup trims inherited orderflow groups before use and leaves foreign files alone', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-disk-cold-'));
  const block = (await statfs(dir)).bsize;
  const old = path.join(dir, groupName(1, 64)), live = path.join(dir, groupName(2, 64)), orphan = path.join(dir, groupName(3, 64));
  const feed = { trades: [], gaps: [], liquidations: [], coverageFrom: null, coverageTo: null };
  const writer = new OrderFlowCheckpoint(old);
  await writer.save(feed);
  await writer.save({...feed,coverageTo: 123});
  const [delta] = await readdir(old+'.d');
  for (const file of [old, path.join(old+'.d',delta)]) await utimes(file, 1, 1);
  await writeFile(path.join(old+'.d', 'unrelated.txt'), 'keep');
  await new OrderFlowCheckpoint(live).save(feed);
  await writeFile(orphan+'.tmp','partial');
  await utimes(orphan+'.tmp', 1, 1);
  const unrelated = old + '.0162b69b-214f-4d42-b89e-f097f3e0b345';
  await writeFile(unrelated,'keep');
  const quota = new SnapshotBudget(dir, 'flow', block, key => key === path.basename(live), 0);
  t.after(async () => { quota.close(); await rm(dir, { recursive:true, force:true }); });
  await quota.init();
  assert.deepEqual(await new OrderFlowCheckpoint(live, quota).load(), feed);
  assert.equal(quota.status().bytes, block);
  await assert.rejects(stat(old), { code:'ENOENT' });
  await assert.rejects(stat(orphan+'.tmp'), { code:'ENOENT' });
  assert.deepEqual(await readdir(old+'.d'), ['unrelated.txt']);
  assert.equal(await readFile(unrelated,'utf8'),'keep');
});

test('maintenance reclaims orphan tape deltas below quota and preserves unrelated files', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-flow-orphans-'));
  const file = path.join(dir, groupName(10, 64));
  const tape = new OrderFlowCheckpoint(file);
  const empty = { trades: [], liquidations: [], gaps: [], coverageFrom: null, coverageTo: null };
  await tape.save(empty);
  await tape.save({...empty, coverageTo: 10});
  await rm(file); // Interrupted between removing the base and its obsolete deltas.
  await writeFile(path.join(file + '.d', 'notes'), 'keep');
  const quota = new SnapshotBudget(dir, 'flow', 10 * 1024 ** 2, () => false, 0);
  t.after(async () => { quota.close(); await rm(dir, {recursive:true, force:true}); });
  await quota.init();
  assert.deepEqual(await readdir(file + '.d'), ['notes']);
  assert.equal(quota.status().bytes, 0);
});

test('oversize market snapshot is still served live without creating a disk snapshot', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-disk-market-'));
  const cache = new MarketCache(dir, 120_000, (await statfs(dir)).bsize);
  t.after(async () => { cache.close(); await rm(dir, { recursive:true, force:true }); });
  const value = 'v'.repeat(100_000);
  const response = await cache.get('large', {ttlMs:60_000, load:async () => value});
  assert.equal(response.value,value);
  assert.deepEqual(await readdir(dir),[]);
  assert.equal(cache.storageStatus()?.skippedWrites,1);
});

test('free-space guard preserves an active tape and refuses even a small optional persist', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-disk-reserve-'));
  const key = groupName(11, 64);
  const file = path.join(dir, key);
  await writeFile(file, 'previous');
  const quota = new SnapshotBudget(dir, 'flow', 16 * 1024 * 1024, group => group === key, Number.MAX_SAFE_INTEGER);
  t.after(async () => { quota.close(); await rm(dir, { recursive:true, force:true }); });
  await quota.init();
  await assert.rejects(quota.write(key, file, 'next'), /free-space/);
  assert.equal(await readFile(file, 'utf8'), 'previous');
  assert.deepEqual(await readdir(dir), [key]);
});

test('alert restart compacts obsolete delivery rows and removed rule runtime in existing state', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-disk-alert-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'alerts', 'state.json');
  await mkdir(path.dirname(file));
  const events = Array.from({length:205},(_, i) => ({id:String(i)}));
  const deliveries = Object.fromEntries(events.map(e => [e.id,{status:'delivered',eventId:e.id}]));
  await writeFile(file,JSON.stringify({version:2,events,runtime:{retired:{}},deliveries}));
  const alerts = new AlertService(dir,() => [],() => []);
  await alerts.init();
  assert.equal(alerts.status().deliveries.length,200);
  const restored = JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(Object.keys(restored.runtime),[]);
  assert.equal(Object.keys(restored.deliveries).length,200);
});
