import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../server/history-store.ts';
import { isVolumeRecord, summarizeVolumeShareHistory, volumeShareHistory } from '../server/volume-share.ts';
import type { VenueVolumeRow } from '../shared/volume.ts';

const NOW = Date.now();
const row = (exchange: 'binance' | 'bybit', spotSharePct: number | null, perpetualSharePct: number | null): VenueVolumeRow => ({
  exchange, spot: null, perpetual: null, spotSharePct, perpetualSharePct, spotPerpVolumeRatio: null, spotPerpBasisBps: null, volumeOiTurnover: null, qualityFlags: [],
  oiUsd: null, fundingRate: null, nextFundingTime: null, freshness: 'live',
});

test('share history reports deltas only with at least two samples', () => {
  const one = summarizeVolumeShareHistory('p', [{ asOf: NOW, rows: [row('binance', 60, 55)] }], NOW);
  assert.equal(one.status, 'insufficient-history');
  assert.equal(one.points, 1);
  assert.equal(one.venues[0].deltaSpotSharePct, null);

  const two = summarizeVolumeShareHistory('p', [
    { asOf: NOW, rows: [row('binance', 60, 55), row('bybit', 40, 45)] },
    { asOf: NOW + 300_000, rows: [row('binance', 52, 50), row('bybit', 48, 50)] },
  ], NOW + 300_000);
  assert.equal(two.status, 'available');
  assert.equal(two.points, 2);
  assert.equal(two.from, NOW);
  assert.equal(two.to, NOW + 300_000);
  const binance = two.venues.find((venue) => venue.exchange === 'binance')!;
  assert.equal(binance.firstSpotSharePct, 60);
  assert.equal(binance.lastSpotSharePct, 52);
  assert.equal(binance.deltaSpotSharePct, -8);
  assert.equal(binance.deltaPerpetualSharePct, -5);
  const bybit = two.venues.find((venue) => venue.exchange === 'bybit')!;
  assert.equal(bybit.deltaSpotSharePct, 8);
});

test('duplicate timestamps keep the newest record and malformed payloads are ignored', () => {
  const summary = summarizeVolumeShareHistory('p', [
    { asOf: NOW, rows: [row('binance', 60, 60)] },
    { asOf: NOW, rows: [row('binance', 70, 70)] },
    { asOf: NOW + 1, rows: [row('binance', 50, 50)] },
  ], NOW + 2);
  assert.equal(summary.points, 2);
  assert.equal(summary.venues.find((venue) => venue.exchange === 'binance')!.lastSpotSharePct, 50);
  assert.equal(isVolumeRecord({ asOf: NOW, rows: [row('binance', 60, 60)] }), true);
  assert.equal(isVolumeRecord({ asOf: NOW, rows: 'nope' }), false);
  assert.equal(isVolumeRecord({ rows: [] }), false);
  assert.equal(isVolumeRecord(null), false);
});

test('volume records persist under the volume history kind and power the share endpoint data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-volume-share-'));
  const history = new HistoryStore(directory);
  try {
    await history.init();
    const base = { projectId: 'p', marketKey: 'project:p', ingestTime: NOW, source: 'nox.volume-matrix.v1', quality: 'live' };
    await history.append({ ...base, id: 'v1', kind: 'volume', eventTime: NOW, payload: { asOf: NOW, rows: [row('binance', 60, 55)] } });
    await history.append({ ...base, id: 'v2', kind: 'volume', eventTime: NOW + 30_000, payload: { asOf: NOW + 30_000, rows: [row('binance', 55, 52)] } });
    const stored = await history.read('p', 'volume', NOW + 60_000);
    assert.equal(stored.length, 2);
    const summary = await volumeShareHistory(history, 'p', NOW + 60_000);
    assert.equal(summary.status, 'available');
    assert.equal(summary.points, 2);
    assert.equal(summary.venues[0].deltaSpotSharePct, -5);
    // Malformed payloads never break the summary.
    await history.append({ ...base, id: 'bad', kind: 'volume', eventTime: NOW + 90_000, payload: { nope: true } });
    assert.equal((await volumeShareHistory(history, 'p', NOW + 100_000)).points, 2);
  } finally {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('KRW share deltas are computed inside the KRW set only', () => {
  const krwRow = (exchange: 'upbit' | 'bithumb', share: number): VenueVolumeRow => ({
    exchange, spot: null, perpetual: null, spotSharePct: share, perpetualSharePct: null, spotPerpVolumeRatio: null, spotPerpBasisBps: null, volumeOiTurnover: null, qualityFlags: [],
    oiUsd: null, fundingRate: null, nextFundingTime: null, freshness: 'live',
  });
  const summary = summarizeVolumeShareHistory('p', [
    { asOf: NOW, rows: [row('binance', 100, 100)], krwRows: [krwRow('upbit', 80), krwRow('bithumb', 20)] },
    { asOf: NOW + 60_000, rows: [row('binance', 100, 100)], krwRows: [krwRow('upbit', 70), krwRow('bithumb', 30)] },
  ], NOW + 60_000);
  assert.equal(summary.venues.length, 1);
  assert.equal(summary.krwVenues.length, 2);
  assert.equal(summary.krwVenues.find((venue) => venue.exchange === 'upbit')!.deltaSpotSharePct, -10);
  assert.equal(summary.krwVenues.find((venue) => venue.exchange === 'bithumb')!.deltaSpotSharePct, 10);
});
