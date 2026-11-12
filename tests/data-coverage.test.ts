import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../server/history-store.ts';
import { projectDataCoverage, summarizeDataCoverage } from '../server/data-coverage.ts';
import type { MarketProject } from '../shared/types.ts';

const NOW = Date.now();
const at = (secondsAgo: number) => ({ eventTime: NOW - secondsAgo * 1000, ingestTime: NOW - secondsAgo * 1000 });

test('coverage states distinguish live, gaps, stale and empty streams', () => {
  const healthy = Array.from({ length: 5 }, (_, index) => at((4 - index) * 30));
  const gappy = [at(1900), at(1000), at(30)];
  const report = summarizeDataCoverage('p', 'active', { snapshot: healthy, volume: gappy, alignment: [], trade: healthy }, NOW);
  const snapshot = report.kinds.find((kind) => kind.kind === 'snapshot')!;
  assert.equal(snapshot.state, 'live');
  assert.equal(snapshot.sampledEvents, 5);
  assert.equal(snapshot.gaps, 0);
  assert.equal(snapshot.expectedCadenceMs, 60_000);
  const volume = report.kinds.find((kind) => kind.kind === 'volume')!;
  assert.equal(volume.state, 'partial');
  assert.equal(volume.expectedCadenceMs, 300_000);
  assert.ok(volume.gaps >= 2);
  assert.ok((volume.largestIngestGapMs ?? 0) > 75_000);
  const alignment = report.kinds.find((kind) => kind.kind === 'alignment')!;
  assert.equal(alignment.state, 'empty');
  assert.deepEqual(report.summary.requiredMissing, ['alignment']);
  assert.ok(report.summary.notes.some((note) => note.includes('missing required')));
  const stale = summarizeDataCoverage('p', 'active', { snapshot: [at(400)], volume: [at(100)], alignment: [at(100)] }, NOW);
  assert.equal(stale.kinds[0].state, 'stale');
  const fiveMinute = summarizeDataCoverage('p', 'active', { volume: [at(810), at(510), at(210)] }, NOW);
  assert.equal(fiveMinute.kinds.find(kind => kind.kind === 'volume')!.state, 'live');
});

test('paused mode reports cadence-free coverage instead of pretending freshness', () => {
  const report = summarizeDataCoverage('p', 'paused', { snapshot: [at(60)], volume: [at(60)], alignment: [at(60)] }, NOW);
  assert.equal(report.expectedCadenceMs, null);
  assert.equal(report.kinds[0].state, 'partial');
  assert.ok(report.summary.notes.some((note) => note.includes('paused')));
});

test('history-backed coverage samples active archives and respects asOf', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-coverage-'));
  const history = new HistoryStore(directory);
  try {
    await history.init();
    const base = { projectId: 'p', marketKey: 'm', source: 'fixture', quality: 'live' };
    const push = (id: string, kind: 'snapshot' | 'volume' | 'alignment' | 'trade', secondsAgo: number) => history.append({ ...base, id, kind, eventTime: NOW - secondsAgo * 1000, ingestTime: NOW - secondsAgo * 1000, payload: {} });
    await push('s1', 'snapshot', 120);
    await push('s2', 'snapshot', 60);
    await push('v1', 'volume', 60);
    await push('a1', 'alignment', 60);
    await push('t1', 'trade', 600);
    const project = { id: 'p', archived: false, monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: 'active' } } as MarketProject;
    const reader = t.mock.method(history, 'read');
    const coverage = await projectDataCoverage(history, project, NOW + 1_000, 5000, false);
    assert.equal(coverage.mode, 'active');
    assert.equal(coverage.kinds.find((kind) => kind.kind === 'snapshot')!.sampledEvents, 2);
    assert.equal(coverage.kinds.find((kind) => kind.kind === 'trade')!.sampledEvents, 0);
    assert.equal(coverage.kinds.find((kind) => kind.kind === 'trade')!.state, 'disabled');
    assert.deepEqual(coverage.summary.notes, []);
    assert.ok(!reader.mock.calls.some(call => call.arguments[1] === 'trade'));
    const enabled = await projectDataCoverage(history, project, NOW + 1_000, 5000, true);
    const trade = enabled.kinds.find(kind => kind.kind === 'trade')!;
    assert.equal(trade.state, 'stale');
    assert.equal(trade.sampledEvents, 1);
    assert.ok(enabled.summary.notes.some(note => note.includes('stale')));
    const cutoff = await projectDataCoverage(history, project, NOW - 90_000);
    assert.equal(cutoff.kinds.find((kind) => kind.kind === 'snapshot')!.sampledEvents, 1);
  } finally {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  }
});
