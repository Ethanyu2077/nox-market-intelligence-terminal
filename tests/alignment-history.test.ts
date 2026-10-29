import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../server/history-store.ts';
import { alignmentHistory, alignmentRecordFromPayload, summarizeAlignmentHistory } from '../server/alignment-history.ts';
import { ProjectCollector } from '../server/collector.ts';
import type { OrderFlowService } from '../server/orderflow-service.ts';
import type { MarketProject, ProjectVenueResponse } from '../shared/types.ts';
import type { AlignmentSnapshotRecord, TimeframeAlignmentResponse } from '../shared/timeframe.ts';

const NOW = Date.now();
const record = (time: number, state: AlignmentSnapshotRecord['state'], allowed: boolean, valid = 3): AlignmentSnapshotRecord => ({
  time, state, directionalClaimAllowed: allowed, validTimeframes: valid,
  observations: [{ interval: '5m', state: 'bullish' }, { interval: '15m', state: 'bullish' }],
});

test('alignment history counts claims and only shows a change when the state flips', () => {
  const summary = summarizeAlignmentHistory('p', [record(NOW, 'mixed', false), record(NOW + 30_000, 'aligned-bullish', true), record(NOW + 60_000, 'aligned-bullish', true)], NOW + 90_000);
  assert.equal(summary.status, 'available');
  assert.equal(summary.points, 3);
  assert.equal(summary.counts['aligned-bullish'], 2);
  assert.equal(summary.counts.mixed, 1);
  assert.equal(summary.allowedPoints, 2);
  assert.ok(Math.abs((summary.allowedSharePct ?? 0) - 200 / 3) < 1e-9);
  assert.deepEqual(summary.lastChange, { from: 'mixed', to: 'aligned-bullish', at: NOW + 30_000 });
  assert.equal(summary.records[0].time, NOW + 60_000);
  assert.equal(summary.outcomeStudy.state, 'not-evaluated');
  assert.ok(summary.methodology.some((item) => item.includes('not predictive')));
  const single = summarizeAlignmentHistory('p', [record(NOW, 'insufficient', false, 0)], NOW);
  assert.equal(single.status, 'insufficient-history');
  assert.equal(single.allowedSharePct, 0);
});

test('stored alignment payloads are validated instead of trusted', () => {
  const valid = alignmentRecordFromPayload(NOW, { generatedAt: NOW, alignment: { state: 'aligned-bearish', directionalClaimAllowed: true, validTimeframes: 4 }, observations: [{ interval: '1m', state: 'bearish' }, { interval: '5m', state: 'bearish' }] }, NOW + 5_000);
  assert.equal(valid?.state, 'aligned-bearish');
  assert.equal(valid?.directionalClaimAllowed, true);
  assert.equal(valid?.validTimeframes, 4);
  assert.equal(valid?.availableAt, NOW + 5_000);
  assert.equal(alignmentRecordFromPayload(NOW, { alignment: { state: 'vibes' } }), null);
  assert.equal(alignmentRecordFromPayload(NOW, null), null);
});

test('alignment snapshots persist under their own history kind and replay with asOf', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-alignment-history-'));
  const history = new HistoryStore(directory);
  try {
    await history.init();
    const base = { projectId: 'p', marketKey: 'project:p', ingestTime: NOW, source: 'nox.timeframe-alignment.v1', quality: 'live' };
    const payload = (state: string, allowed: boolean) => ({ generatedAt: NOW, alignment: { state, directionalClaimAllowed: allowed, validTimeframes: 3 }, observations: [{ interval: '5m', state: 'bullish' }] });
    await history.append({ ...base, id: 'a1', kind: 'alignment', eventTime: NOW, ingestTime: NOW + 7_000, payload: payload('aligned-bullish', true) });
    await history.append({ ...base, id: 'a2', kind: 'alignment', eventTime: NOW + 30_000, payload: payload('conflict', false) });
    await history.append({ ...base, id: 'bad', kind: 'alignment', eventTime: NOW + 40_000, payload: { nope: true } });
    const summary = await alignmentHistory(history, 'p', NOW + 60_000);
    assert.equal(summary.points, 2);
    assert.equal(summary.counts['aligned-bullish'], 1);
    assert.equal(summary.counts.conflict, 1);
    const replay = await alignmentHistory(history, 'p', NOW + 10_000);
    assert.equal(replay.points, 1);
    assert.equal(replay.records[0].availableAt, NOW + 7_000);
  } finally {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('collector persists an alignment claim only when a recorder is provided and respects cadence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-alignment-collector-'));
  const history = new HistoryStore(directory);
  try {
    await history.init();
    const project = {
      id: 'p-collect', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
      markets: [{ id: 'binance:perpetual:ARBUSDT', exchange: 'binance', marketType: 'perpetual', symbol: 'ARBUSDT', base: 'ARB', quote: 'USDT', status: 'TRADING' }],
      primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: 'active' }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
    } as MarketProject;
    const flowStub = { acquire: () => () => {}, snapshot: () => ({ venues: [], aggregates: { spot: { buckets: [] }, perpetual: { buckets: [] } } }) } as unknown as OrderFlowService;
    let alignmentCalls = 0;
    const alignmentResponse: TimeframeAlignmentResponse = { projectId: project.id, symbol: 'ARBUSDT', generatedAt: NOW, observations: [], alignment: { state: 'insufficient', directionalClaimAllowed: false, validTimeframes: 0, alignedTimeframes: 0, reasons: ['fixture'], invalidation: [] }, methodology: [] };
    const worker = new ProjectCollector(() => [project], flowStub, history, async () => ({ snapshots: [], failures: [] } as unknown as ProjectVenueResponse), undefined, undefined, async () => ({ legs: [], failures: [] }), async () => { alignmentCalls += 1; return alignmentResponse; });
    await worker.tick();
    assert.equal(alignmentCalls, 1);
    const stored = await history.read(project.id, 'alignment', Date.now());
    assert.equal(stored.length, 1);
    assert.equal(stored[0].eventTime, stored[0].ingestTime, 'alignment event time must be the decision-complete time');
    await worker.tick();
    assert.equal(alignmentCalls, 1, 'second immediate tick must respect the 30s cadence');
    await worker.close();
  } finally {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  }
});
