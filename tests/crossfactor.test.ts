import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactorEvidence, factorSamplesFromSnapshots } from '../server/crossfactor.ts';
import type { FactorSample } from '../shared/crossfactor.ts';

const series = (venue: string, values: number[], unit = 'bps', coveragePct = 100): FactorSample[] =>
  values.map((value, index) => ({ venue, factor: 'funding_basis', time: 1_700_000_000_000 + index * 60_000, availableAt: 1_700_000_000_000 + index * 60_000 + 500, value, unit, coveragePct }));

test('two comparable venues produce descriptive evidence with leader and lag', () => {
  const values = Array.from({ length: 80 }, (_, i) => Math.sin(i / 5));
  const report = buildFactorEvidence('funding_basis', [...series('binance', values), ...series('bybit', values.slice(5).concat(values.slice(0, 5)))], { minSamples: 30 });
  assert.equal(report.comparable, true);
  assert.equal(report.verdict, 'descriptive');
  assert.ok(report.leader && report.follower);
  assert.ok(report.correlation != null);
});

test('mixed units are not comparable', () => {
  const report = buildFactorEvidence('funding_basis', [...series('binance', [1, 2, 3], 'bps'), ...series('bybit', [1, 2, 3], 'percent')]);
  assert.equal(report.comparable, false);
  assert.equal(report.verdict, 'unavailable');
  assert.match(report.reasons[0], /Mixed units/);
});

test('low coverage and thin samples are refused, never zero-filled', () => {
  const report = buildFactorEvidence('funding_basis', [...series('binance', Array.from({ length: 40 }, () => 1), 'bps', 20), ...series('bybit', Array.from({ length: 40 }, () => 1), 'bps', 20)]);
  assert.equal(report.comparable, false);
  assert.ok(report.reasons.some((reason) => /coverage/.test(reason)));
  const sparse = buildFactorEvidence('funding_basis', [...series('binance', [1, 2]), ...series('bybit', [1, 2])]);
  assert.equal(sparse.verdict, 'unavailable');
  const missing = buildFactorEvidence('funding_basis', [...series('binance', [null as never, null as never]), ...series('bybit', [null as never, null as never])]);
  assert.equal(missing.verdict, 'unavailable');
});

test('snapshot journal yields OI and funding-basis samples with units', () => {
  const samples = factorSamplesFromSnapshots([{ ingestTime: 1_700_000_001_000, payload: { snapshots: [{ exchange: 'binance', price: 100, markPrice: 100.1, oiBase: 5_000, fundingRate: 0.0001, eventTime: 1_700_000_000_000 }] } }]);
  assert.deepEqual(samples.map((sample) => sample.factor).sort(), ['funding_basis', 'oi_change']);
  assert.equal(samples.find((sample) => sample.factor === 'oi_change')?.unit, 'base');
  assert.equal(samples.find((sample) => sample.factor === 'funding_basis')?.unit, 'bps');
  assert.equal(samples[0].availableAt, 1_700_000_001_000);
});
