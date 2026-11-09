import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ESM migration tooling
import { evaluateTarget, reconcileIds, readCheckpoint, writeCheckpointAtomic } from '../scripts/migration/lib/migration-safety.mjs';

test('target identity requires explicit target, expected and matching database', () => {
  assert.equal(evaluateTarget({ target: 'test', expectedDb: 'nox_test', actualDb: 'nox_test' }).ok, true);
  assert.equal(evaluateTarget({ target: 'test', expectedDb: 'nox_test', actualDb: 'nox_prod' }).ok, false);
  assert.match(evaluateTarget({ target: 'test', expectedDb: 'nox_test', actualDb: 'nox_prod' }).reason, /does not match/);
  assert.equal(evaluateTarget({ expectedDb: 'nox_test', actualDb: 'nox_test' }).ok, false);
  assert.equal(evaluateTarget({ target: 'test' }).ok, false);
});

test('production migration needs a separate explicit acknowledgement', () => {
  assert.equal(evaluateTarget({ target: 'production', expectedDb: 'nox', actualDb: 'nox' }).ok, false);
  assert.equal(evaluateTarget({ target: 'production', expectedDb: 'nox', actualDb: 'nox', productionAck: 'nox' }).ok, true);
  assert.equal(evaluateTarget({ target: 'production', expectedDb: 'nox', actualDb: 'nox', productionAck: 'yes' }).ok, false);
});

test('reconciliation reports missing event ids, not just counts', () => {
  const result = reconcileIds(['a', 'b', 'c'], ['a', 'c']);
  assert.equal(result.ok, false);
  assert.equal(result.missing, 1);
  assert.deepEqual(result.missingSample, ['b']);
  assert.equal(reconcileIds(['a'], ['a']).ok, true);
});

test('checkpoint writes are atomic and readable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nox-mig-'));
  const file = path.join(dir, 'checkpoint.json');
  await writeCheckpointAtomic(file, { version: 1, files: { a: { lines: 10 } } });
  const loaded = await readCheckpoint(file);
  assert.equal(loaded.files.a.lines, 10);
  await writeCheckpointAtomic(file, { version: 1, files: { a: { lines: 20 } } });
  assert.equal((await readCheckpoint(file)).files.a.lines, 20);
  assert.equal((await readFile(file, 'utf8')).includes('tmp'), false);
});
