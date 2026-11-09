import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain ESM tooling module
import { inspectJournal, sha256, checkpointFor, canResume } from '../scripts/migration/lib/journal-inspect.mjs';

const line = (id: string, eventTime: number, kind = 'snapshot') => JSON.stringify({ event: { id, kind, marketKey: 'binance:perpetual:BTCUSDT', projectId: 'p1', eventTime, ingestTime: eventTime + 1, source: 't', quality: 'live', payload: {} } });

test('inspects records, kinds, time range and malformed lines', () => {
  const result = inspectJournal([line('a', 100), line('b', 200), '{broken', '', line('c', 50, 'l2')]);
  assert.equal(result.records, 3);
  assert.equal(result.malformed, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(result.minEventTime, 50);
  assert.equal(result.maxEventTime, 200);
  assert.deepEqual(result.byKind, { snapshot: 2, l2: 1 });
});

test('duplicate event ids are counted, not silently merged', () => {
  const result = inspectJournal([line('a', 100), line('a', 100)]);
  assert.equal(result.records, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.uniqueIds, 1);
});

test('sha256 is stable and changes with content', () => {
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
});

test('checkpoint binds file hash and resumes only on the same content', () => {
  const hash = sha256('one\ntwo\n');
  const checkpoint = checkpointFor(null, '2026-11-09-snapshot.ndjson', hash, 7, 2);
  assert.equal(canResume(checkpoint, '2026-11-09-snapshot.ndjson', hash), true);
  assert.equal(canResume(checkpoint, '2026-11-09-snapshot.ndjson', sha256('changed')), false);
  assert.equal(canResume(checkpoint, 'other.ndjson', hash), false);
});
