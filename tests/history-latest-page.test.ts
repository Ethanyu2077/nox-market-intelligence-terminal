import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { HistoryStore, type HistoryEvent } from '../server/history-store.ts';
import { archiveClosedJournals, journalBytes, journalSegments } from '../server/journal-archive.ts';
import { parseJournalRecords } from '../server/journal-records.ts';

function event(id: string, eventTime: number, payload: string): HistoryEvent {
  return { id, eventTime, ingestTime: eventTime, kind: 'trade', marketKey: 'test', projectId: 'p', source: 'fixture', quality: 'live', payload };
}
const lines = (events: HistoryEvent[]) => events.map(e => JSON.stringify(e) + '\n').join('');

async function archived(dir: string, day: string, events: HistoryEvent[], indexTime: boolean) {
  const name = day + '-trade.ndjson';
  const file = path.join(dir, name);
  await writeFile(file, lines(events));
  await utimes(file, new Date(day), new Date(day));
  await archiveClosedJournals(dir, candidate => candidate === name, { indexTime });
  const [partition] = await journalSegments(dir, candidate => candidate === name);
  assert.ok(partition.compressed);
  return partition;
}

test('latest local page skips older archives only after finding the pagination lookahead', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-latest-page-'));
  const history = path.join(dir, 'history'), store = new HistoryStore(dir);
  try {
    await mkdir(history);
    const old = await archived(history, '2020-01-01', [event('old', 10, '')], true);
    // A deliberately unreadable row proves exactly when the query opens this archive.
    await writeFile(old.file, gzipSync('x'.repeat(old.size - 1) + '\n'));
    await writeFile(path.join(history, '2020-01-02-trade.ndjson'), lines([event('a', 20, ''), event('b', 30, '')]));
    await store.init();
    const latest = await store.page('p', { kind: 'trade', limit: 1 });
    assert.deepEqual(latest.items.map(e => e.id), ['b']);
    assert.ok(latest.nextCursor);
    await assert.rejects(store.page('p', { kind: 'trade', limit: 1, cursor: latest.nextCursor }), /Corrupt journal/);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('equal-time archives preserve first-written duplicates and unindexed archives remain searchable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-latest-ties-'));
  const history = path.join(dir, 'history'), store = new HistoryStore(dir);
  try {
    await mkdir(history);
    await archived(history, '2020-01-01', [event('z', 30, 'first'), event('z', 30, 'same file duplicate')], true);
    await archived(history, '2020-01-02', [event('newest', 40, 'unindexed')], false);
    await writeFile(path.join(history, '2020-01-03-trade.ndjson'), lines([event('z', 30, 'later file duplicate'), event('a', 30, 'tie')]));
    await store.init();
    const first = await store.page('p', { kind: 'trade', limit: 2 });
    assert.deepEqual(first.items.map(e => e.payload), ['unindexed', 'first']);
    assert.ok(first.nextCursor);
    const second = await store.page('p', { kind: 'trade', limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.items.map(e => e.payload), ['tie']);
    assert.equal(second.nextCursor, null);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent reads of a corrupt archive close cleanly and preserve the original parse or gzip error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-archive-close-'));
  try {
    const archive = await archived(dir, '2020-01-01', [event('old', 10, '')], true);
    const read = async () => {
      for await (const row of parseJournalRecords(journalBytes(archive), archive.name, archive.identity))
        assert.fail(`unexpected record at ${row.offset}`);
    };
    await writeFile(archive.file, gzipSync('x'.repeat(archive.size - 1) + '\n'));
    for (let i = 0; i < 16; i++)
      await Promise.all(Array.from({length: 16}, () => assert.rejects(read(), /Corrupt journal/)));
    await writeFile(archive.file, 'invalid gzip');
    await assert.rejects(read(), {code: 'Z_DATA_ERROR'});
  } finally { await rm(dir, {recursive: true, force: true}); }
});
