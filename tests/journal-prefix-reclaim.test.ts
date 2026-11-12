import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { journalSegments } from '../server/journal-archive.ts';
import { cleanupJournalPrefixTemp, reclaimJournalPrefix } from '../server/journal-prefix-reclaim.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-prefix-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const name = 'history-trade.ndjson', original = path.join(directory, name);
  const prefix = Buffer.from('{"id":"confirmed","payload":"' + 'x'.repeat(300_000) + '"}\n');
  const suffix = Buffer.concat([Buffer.from('{"id":"waiting"}\n'), Buffer.alloc(80_000, 128), Buffer.from('{"torn":')]);
  const full = Buffer.concat([prefix, suffix]);
  await writeFile(original, full);
  const inspect = async () => {
    const [item] = await journalSegments(directory, file => file === name);
    return { ...item, dbKey: item.key };
  };
  const file = await inspect();
  const saved = { offset: prefix.length, identity: file.identity, birth: file.birth };
  return { directory, original, full, prefix, suffix, file, inspect, saved };
}

test('raw compaction retains every unacknowledged byte and invalidates old checkpoints across a restart', async t => {
  const {directory, original, file, inspect, saved, prefix, suffix} = await fixture(t);
  assert.equal(await reclaimJournalPrefix(file, saved, suffix.length, () => true), prefix.length);
  assert.deepEqual(await readFile(original), suffix);
  const replacement = await inspect();
  assert.notEqual(replacement.identity, saved.identity);
  assert.equal(await reclaimJournalPrefix(replacement, saved, suffix.length, () => true), 0);
  assert.deepEqual(await readdir(directory), [file.name]);
});

test('uncertain identity, unsafe offset, insufficient headroom, and loss of verification keep the source intact', async t => {
  const {directory, original, full, file, saved, suffix} = await fixture(t);
  const enough = suffix.length + 10;
  for (const candidate of [
    undefined, {...saved, birth: undefined}, {...saved, birth: 0}, {...saved, identity: 'old'},
    {...saved, offset: saved.offset - 1}, {...saved, offset: -1}, {...saved, offset: file.size},
  ]) {
    assert.equal(await reclaimJournalPrefix(file, candidate, enough, () => true), 0);
  }
  assert.equal(await reclaimJournalPrefix(file, saved, suffix.length - 1, () => true), 0);
  assert.equal(await reclaimJournalPrefix({...file, key: 'sealed'}, saved, enough, () => true), 0);
  assert.equal(await reclaimJournalPrefix({...file, copies: ['other']}, saved, enough, () => true), 0);
  let verified = true;
  assert.equal(await reclaimJournalPrefix(file, saved, enough, () => {
    const previous = verified;
    verified = false;
    return previous;
  }), 0);
  assert.deepEqual(await readFile(original), full);
  assert.deepEqual(await readdir(directory), [file.name]);
});

test('an interrupted prefix staging write is disposable and retry leaves exactly one suffix', async t => {
  const {directory, original, full, file, saved, prefix, suffix} = await fixture(t);
  await writeFile(path.join(directory, '.nox-journal-prefix.tmp'), suffix.subarray(0, 11));
  await assert.rejects(reclaimJournalPrefix(file, saved, suffix.length, () => true), {code: 'EEXIST'});
  assert.deepEqual(await readFile(original), full);
  await cleanupJournalPrefixTemp(directory);
  assert.equal(await reclaimJournalPrefix(file, saved, suffix.length, () => true), prefix.length);
  assert.deepEqual(await readFile(original), suffix);
});
