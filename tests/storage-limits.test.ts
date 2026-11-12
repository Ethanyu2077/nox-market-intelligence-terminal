import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { archiveClosedJournals, cleanupAbandonedArchiveTemps } from '../server/journal-archive.ts';
import { storageLimit } from '../server/storage-limits.ts';

test('invalid storage settings retain a finite positive default', t => {
  const key = 'NOX_TEST_WINDOW_DAYS';
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  });
  for (const setting of ['0', '-1', 'Infinity', '1.5', '', '99999999999999999999', '36501']) {
    process.env[key] = setting;
    assert.equal(storageLimit(key, 45), 45);
  }
  process.env[key] = ' 2 ';
  assert.equal(storageLimit(key, 45), 2);
});

test('archive staging respects its owner’s budget and returns the reservation even on failure', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-staging-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = '2000-01-01-trade.ndjson';
  await writeFile(path.join(dir, file), '{}\n'.repeat(10_000));
  await utimes(path.join(dir, file), new Date(0), new Date(0));
  const accepts = (name: string) => name === file;
  let released = 0;
  const limit = (bytes: number) => ({ reserve: async () => ({ bytes, release: () => { released++; } }) });
  await archiveClosedJournals(dir, accepts, limit(0));
  assert.deepEqual(await readdir(dir), [file]);
  await assert.rejects(archiveClosedJournals(dir, accepts, limit(10)), /space/i);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false);
  await archiveClosedJournals(dir, accepts, limit(5_000));
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('.gz'));
  assert.equal(released, 3);
});

test('startup reclaims only unpublished compression files for managed partitions', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-startup-staging-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = '01234567-89ab-4cde-8fab-0123456789ab';
  const stem = '2000-01-01-trade.ndjson.1-2-b3-' + id;
  const preserved = [stem + '.sealed', 'manual.gz.tmp', 'other.ndjson.1-2-b3-' + id + '.' + id + '.gz.tmp'];
  await Promise.all([...preserved, stem + '.' + id + '.gz.tmp'].map(name => writeFile(path.join(dir, name), 'data')));
  await cleanupAbandonedArchiveTemps(dir, name => name === '2000-01-01-trade.ndjson');
  assert.deepEqual((await readdir(dir)).sort(), preserved.sort());
});
