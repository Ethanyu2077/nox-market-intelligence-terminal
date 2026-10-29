import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeAlignmentOutcomes, type OutcomeSnapshot } from '../server/alignment-outcome.ts';
import type { AlignmentSnapshotRecord } from '../shared/timeframe.ts';

const MIN = 60_000;
const BASE = Date.UTC(2026, 9, 28, 0, 0, 0);
const snapshotsAt = (count: number, stepMin: number, startPrice = 100): OutcomeSnapshot[] => Array.from({ length: count }, (_, index) => ({ time: BASE + index * stepMin * MIN, price: startPrice * (1 + index * 0.001) }));
const record = (minutes: number, state: AlignmentSnapshotRecord['state'], allowed = true): AlignmentSnapshotRecord => ({ time: BASE + minutes * MIN, state, directionalClaimAllowed: allowed, validTimeframes: 4, observations: [] });

test('alignment outcomes use post-event entry, half-horizon exit and subtract costs', () => {
  const snapshots = snapshotsAt(20, 5); // every 5 minutes for 95 minutes
  const response = summarizeAlignmentOutcomes('p', 'ARBUSDT', [record(1, 'aligned-bullish')], snapshots, { asOf: BASE + 200 * MIN, horizonMinutes: 60, costBps: 10, minSample: 1 });
  assert.equal(response.allowedEvents, 1);
  assert.equal(response.resolvedSamples, 1);
  assert.equal(response.rows[0].entryTime, BASE + 5 * MIN);
  assert.equal(response.rows[0].exitTime, BASE + 60 * MIN);
  const expectedGross = (snapshots[12].price / snapshots[1].price - 1) * 100;
  assert.ok(Math.abs(response.rows[0].grossReturnPct! - expectedGross) < 1e-9);
  assert.ok(Math.abs(response.rows[0].netReturnPct! - (expectedGross - 0.1)) < 1e-9);
  assert.equal(response.status, 'available');
  assert.equal(response.hitRate, 100);
  assert.ok(response.baselineHitRate != null);
});

test('refused claims are excluded and no hit rate is shown below the minimum sample', () => {
  const snapshots = snapshotsAt(20, 5);
  const response = summarizeAlignmentOutcomes('p', 'ARBUSDT', [record(1, 'aligned-bullish'), record(6, 'mixed', false), record(11, 'insufficient', false)], snapshots, { asOf: BASE + 200 * MIN, horizonMinutes: 60, costBps: 10 });
  assert.equal(response.allowedEvents, 1);
  assert.equal(response.resolvedSamples, 1);
  assert.equal(response.status, 'insufficient-sample');
  assert.equal(response.hitRate, null);
  assert.equal(response.liftPct, null);
  assert.ok(response.methodology.some((item) => item.includes('refusal')));
});

test('outcomes are censored when the horizon is not reached within the asOf cutoff', () => {
  const snapshots = snapshotsAt(20, 5);
  const response = summarizeAlignmentOutcomes('p', 'ARBUSDT', [record(1, 'aligned-bearish')], snapshots, { asOf: BASE + 20 * MIN, horizonMinutes: 60, costBps: 10, minSample: 1 });
  assert.equal(response.resolvedSamples, 0);
  assert.equal(response.censoredSamples, 1);
  assert.equal(response.status, 'insufficient-sample');
  assert.match(response.rows[0].reason ?? '', /horizon/);
});

test('direction mapping and negative outcomes are measured against the claim direction', () => {
  const falling = Array.from({ length: 20 }, (_, index) => ({ time: BASE + index * 5 * MIN, price: 100 * (1 - index * 0.001) }));
  const bullish = summarizeAlignmentOutcomes('p', 'ARBUSDT', [record(1, 'aligned-bullish')], falling, { asOf: BASE + 200 * MIN, horizonMinutes: 60, costBps: 0, minSample: 1 });
  assert.equal(bullish.hitRate, 0);
  assert.ok(bullish.averageNetReturnPct! < 0);
  const bearish = summarizeAlignmentOutcomes('p', 'ARBUSDT', [record(1, 'aligned-bearish')], falling, { asOf: BASE + 200 * MIN, horizonMinutes: 60, costBps: 0, minSample: 1 });
  assert.equal(bearish.hitRate, 100);
});

test('entry cannot precede the time the claim actually became available', () => {
  const snapshots = snapshotsAt(20, 5);
  const recordWithAvailability = { ...record(1, 'aligned-bullish'), availableAt: BASE + 7 * MIN };
  const response = summarizeAlignmentOutcomes('p', 'ARBUSDT', [recordWithAvailability], snapshots, { asOf: BASE + 200 * MIN, horizonMinutes: 60, costBps: 0, minSample: 1 });
  assert.equal(response.rows[0].entryTime, BASE + 10 * MIN, 'first snapshot at/after availableAt (7m) is 10m');
  assert.equal(response.rows[0].exitTime, BASE + 65 * MIN, 'last snapshot <= decision(7m)+60m is 65m');
});

test('short claims use directional P&L: a small rise with costs is a loss, not a hit', () => {
  const snapshots = [{ time: BASE + 5 * MIN, price: 100 }, { time: BASE + 60 * MIN, price: 100.05 }];
  const bearish = { ...record(1, 'aligned-bearish'), availableAt: BASE + 2 * MIN };
  const response = summarizeAlignmentOutcomes('p', 'ARBUSDT', [bearish], snapshots, { asOf: BASE + 200 * MIN, horizonMinutes: 60, costBps: 10, minSample: 1 });
  assert.equal(response.resolvedSamples, 1);
  const row = response.rows[0];
  assert.ok(Math.abs(row.priceReturnPct! - 0.05) < 1e-9);
  assert.ok(Math.abs(row.grossReturnPct! + 0.05) < 1e-9, 'short gross is -price return');
  assert.ok(Math.abs(row.netReturnPct! + 0.15) < 1e-9, 'cost is subtracted after direction adjustment');
  assert.equal(response.hitRate, 0, 'a losing short must never count as a hit because cost made net negative');
  assert.ok(response.averageNetReturnPct! < 0);

  // Same move as a long is also a loss after 10bps cost, but for the correct reason.
  const bullish = { ...record(1, 'aligned-bullish'), availableAt: BASE + 2 * MIN };
  const long = summarizeAlignmentOutcomes('p', 'ARBUSDT', [bullish], snapshots, { asOf: BASE + 200 * MIN, horizonMinutes: 60, costBps: 10, minSample: 1 });
  assert.equal(long.hitRate, 0);
  assert.ok(Math.abs(long.rows[0].netReturnPct! + 0.05) < 1e-9);
});

test('alignmentOutcomes uses history ingestTime as availability (integration path, R18 review)', async () => {
  const { HistoryStore } = await import('../server/history-store.ts');
  const { alignmentOutcomes } = await import('../server/alignment-outcome.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathModule = await import('node:path');
  const t = BASE;
  const directory = await mkdtemp(pathModule.join(tmpdir(), 'nox-outcome-ingest-'));
  const history = new HistoryStore(directory);
  try {
    await history.init();
    const project = {
      id: 'p-ingest', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
      markets: [{ id: 'binance:perpetual:ORDERUSDT', exchange: 'binance', marketType: 'perpetual', symbol: 'ORDERUSDT', base: 'ORDER', quote: 'USDT', status: 'TRADING' }],
      primaryMarketId: 'binance:perpetual:ORDERUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: 'active' }, archived: false, order: 0, createdAt: t, updatedAt: t,
    } as const;
    const snapshot = (id: string, offsetMin: number, price: number) => history.append({ id, kind: 'snapshot', marketKey: 'binance:perpetual:ORDERUSDT', projectId: 'p-ingest', eventTime: t + offsetMin * MIN, ingestTime: t + offsetMin * MIN, source: 'fixture', quality: 'live', payload: { exchange: 'binance', marketType: 'perpetual', symbol: 'ORDERUSDT', price } });
    await snapshot('s1', 1, 100);
    await snapshot('s10', 10, 110);
    await snapshot('s60', 60, 120);
    // Alignment generated at t, but only ingested/available at t+7m (slow collector fetch).
    await history.append({ id: 'a1', kind: 'alignment', marketKey: 'project:p-ingest', projectId: 'p-ingest', eventTime: t, ingestTime: t + 7 * MIN, source: 'nox.timeframe-alignment.v1', quality: 'live', payload: { generatedAt: t, alignment: { state: 'aligned-bullish', directionalClaimAllowed: true, validTimeframes: 4 }, observations: [] } });
    const response = await alignmentOutcomes(history, project as never, { horizonMinutes: 60, costBps: 0 });
    assert.equal(response.allowedEvents, 1);
    assert.equal(response.rows[0].entryTime, t + 10 * MIN, 'entry must wait for ingest/availability (t+7m), so first snapshot is t+10m');
    assert.equal(response.rows[0].entryPrice, 110);
    const tooEarly = await alignmentOutcomes(history, project as never, { horizonMinutes: 60, costBps: 0, asOf: t + 3 * MIN });
    assert.equal(tooEarly.allowedEvents, 0, 'asOf before ingest must not reveal the claim');
  } finally {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  }
});
