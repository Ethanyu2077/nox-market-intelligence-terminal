import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendJournalBatch } from '../server/journal-append.ts';

test('a short disk-full write rolls back the entire batch before a retry', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-short-append-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'daily.ndjson'), initial = '{"id":1}\n';
  const batch = '{"id":2}\n{"id":3}\n';
  await appendJournalBatch(file, initial);
  const probe = await open(file, 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const failure = t.mock.method(proto, 'writeFile', async function (this: FileHandle) {
    await this.write('{"id":2}\n{"id":');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  await assert.rejects(appendJournalBatch(file, batch), { code: 'ENOSPC' });
  failure.mock.restore();
  assert.equal(await readFile(file, 'utf8'), initial);
  await appendJournalBatch(file, batch);
  assert.equal(await readFile(file, 'utf8'), initial + batch);
});

test('after restart a pre-existing torn tail is preserved and blocks further appends', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-torn-append-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'daily.ndjson'), initial = '{"id":1}\n{';
  await writeFile(file, initial);
  await assert.rejects(appendJournalBatch(file, '{"id":2}\n'), /Incomplete journal tail/);
  assert.equal(await readFile(file, 'utf8'), initial);
});
