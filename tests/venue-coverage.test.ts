import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../server/history-store.ts';
import { summarizeVenueCoverage, venueCoverage, type VenueCoverageRecord } from '../server/venue-coverage.ts';
import type { MarketProject } from '../shared/types.ts';
import type { VenueVolumeRow } from '../shared/volume.ts';

const NOW = Date.now();
const project: MarketProject = {
  id: 'p', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
  markets: [
    { id: 'binance:spot:ARBUSDT', exchange: 'binance', marketType: 'spot', symbol: 'ARBUSDT', base: 'ARB', quote: 'USDT', status: 'TRADING' },
    { id: 'binance:perpetual:ARBUSDT', exchange: 'binance', marketType: 'perpetual', symbol: 'ARBUSDT', base: 'ARB', quote: 'USDT', status: 'TRADING' },
    { id: 'bybit:perpetual:ARBUSDT', exchange: 'bybit', marketType: 'perpetual', symbol: 'ARBUSDT', base: 'ARB', quote: 'USDT', status: 'Trading' },
    { id: 'upbit:spot:KRW-ARB', exchange: 'upbit', marketType: 'spot', symbol: 'KRW-ARB', base: 'ARB', quote: 'KRW', status: 'listed' },
  ],
  primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: 'active' }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
};
const leg = (quality: 'live' | 'partial' | 'stale' = 'live') => ({ exchange: 'binance' as const, marketType: 'spot' as const, symbols: ['X'], quote: 'USDT', price: 1, volume24hBase: 1, volume24hQuote: 1, volume24hUsd: 1, eventTime: NOW, fetchedAt: NOW, quality, source: 'fixture', unavailable: [] });
const row = (exchange: VenueVolumeRow['exchange'], spot: boolean, perp: boolean, quality: 'live' | 'partial' | 'stale' = 'live'): VenueVolumeRow => ({
  exchange,
  spot: spot ? { ...leg(quality), exchange } : null,
  perpetual: perp ? { ...leg(quality), exchange, marketType: 'perpetual' } : null,
  spotSharePct: null, perpetualSharePct: null, spotPerpVolumeRatio: null, spotPerpBasisBps: null, volumeOiTurnover: null, qualityFlags: [],
  oiUsd: null, fundingRate: null, nextFundingTime: null, freshness: quality,
});

test('venue coverage tracks per-exchange spot/perp legs and explicit failures', () => {
  const records: VenueCoverageRecord[] = [
    { asOf: NOW - 30_000, rows: [row('binance', true, true), row('bybit', false, true, 'partial')], krwRows: [row('upbit', true, false)], failures: [{ exchange: 'bybit', marketType: 'spot', symbol: 'ARBUSDT', quote: 'USDT', message: 'spot disabled' }, { exchange: 'bybit', marketType: 'perpetual', symbol: 'ARBUSDT', quote: 'USDT', message: 'timeout' }] },
    { asOf: NOW, rows: [row('binance', true, true)], krwRows: [row('upbit', true, false)], failures: [{ exchange: 'bybit', marketType: 'perpetual', symbol: 'ARBUSDT', quote: 'USDT', message: 'timeout' }] },
  ];
  const report = summarizeVenueCoverage(project, records, NOW);
  assert.equal(report.points, 2);
  const binance = report.venues.find((venue) => venue.exchange === 'binance')!;
  assert.equal(binance.state, 'both');
  assert.equal(binance.spotSamples, 2);
  assert.equal(binance.perpSamples, 2);
  assert.equal(binance.spotQuality, 'live');
  const bybit = report.venues.find((venue) => venue.exchange === 'bybit')!;
  assert.equal(bybit.perpSamples, 1);
  assert.equal(bybit.spotSamples, 0);
  assert.equal(bybit.state, 'perp-only');
  const upbit = report.venues.find((venue) => venue.exchange === 'upbit')!;
  assert.equal(upbit.state, 'spot-only');
  assert.equal(upbit.spotSamples, 2);
  assert.equal(report.failures.find((failure) => failure.exchange === 'bybit' && failure.marketType === 'perpetual')!.count, 2);
  assert.equal(report.summary.expectedVenues, 3);
  assert.equal(report.summary.venuesWithBothLegs, 1);
});

test('missing legs and empty history stay explicit instead of zero-filled', () => {
  const empty = summarizeVenueCoverage(project, [], NOW);
  assert.equal(empty.points, 0);
  assert.ok(empty.venues.every((venue) => venue.state === 'missing'));
  assert.ok(empty.summary.missingLegs.includes('binance:spot'));
  assert.ok(empty.summary.missingLegs.includes('upbit:spot'));
  const partial = summarizeVenueCoverage(project, [{ asOf: NOW, rows: [row('binance', true, false)] }], NOW);
  const binance = partial.venues.find((venue) => venue.exchange === 'binance')!;
  assert.equal(binance.state, 'spot-only');
  assert.ok(partial.summary.missingLegs.includes('binance:perpetual'));
});

test('venue coverage reads persisted volume records with asOf cutoff and ignores malformed payloads', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-venue-coverage-'));
  const history = new HistoryStore(directory);
  try {
    await history.init();
    const base = { projectId: 'p', marketKey: 'project:p', source: 'nox.volume-matrix.v1', quality: 'live' };
    const payload = (asOf: number) => ({ asOf, rows: [row('binance', true, true)], krw: { rows: [row('upbit', true, false)] }, failures: [] });
    await history.append({ ...base, id: 'v1', kind: 'volume', eventTime: NOW - 30_000, ingestTime: NOW - 30_000, payload: payload(NOW - 30_000) });
    await history.append({ ...base, id: 'v2', kind: 'volume', eventTime: NOW, ingestTime: NOW, payload: payload(NOW) });
    await history.append({ ...base, id: 'bad', kind: 'volume', eventTime: NOW + 1, ingestTime: NOW + 1, payload: { nope: true } });
    const report = await venueCoverage(history, project, NOW + 1_000);
    assert.equal(report.points, 2);
    assert.equal(report.venues.find((venue) => venue.exchange === 'binance')!.state, 'both');
    assert.equal(report.venues.find((venue) => venue.exchange === 'upbit')!.spotSamples, 2);
    const cutoff = await venueCoverage(history, project, NOW - 10_000);
    assert.equal(cutoff.points, 1);
  } finally {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  }
});
