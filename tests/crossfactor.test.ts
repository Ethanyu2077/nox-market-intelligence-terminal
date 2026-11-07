import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactorEvidence, factorSamplesFromSnapshots } from '../server/crossfactor.ts';
import type { FactorSample } from '../shared/crossfactor.ts';

const T0 = 1_700_000_000_000;
const STEP = 60_000;

/** A alternates +/-1%; B's next move is the opposite of A's current move. */
function inverseLead(n = 120): { a: FactorSample[]; b: FactorSample[] } {
  // A's next move is the inverse of B's current move, so A leads with a NEGATIVE correlation.
  const a: FactorSample[] = [], b: FactorSample[] = [];
  const returns = Array.from({ length: n }, (_, i) => Math.sin(i / 3) * 0.01);
  let priceA = 100, priceB = 100;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) { priceA *= 1 + returns[i - 1]; priceB *= 1 - returns[i - 1]; }
    const time = T0 + i * STEP;
    a.push({ venue: 'binance', factor: 'oi_delta', time, availableAt: time, value: priceA, unit: 'pct', coveragePct: 100 });
    b.push({ venue: 'bybit', factor: 'oi_delta', time, availableAt: time, value: priceB, unit: 'pct', coveragePct: 100 });
  }
  return { a, b };
}

const opts = { minSamples: 20, minCoveragePct: 50, windowMs: 60_000, horizonMs: 60_000, maxLagSteps: 2, lagStepMs: 60_000, bootstrap: undefined } as const;

test('symmetric relationships are reported as direction-ambiguous, not assigned by sign', () => {
  const { a, b } = inverseLead();
  const report = buildFactorEvidence('oi_delta', [...a, ...b], opts);
  assert.equal(report.comparable, true);
  assert.equal(report.leader, null, 'a symmetric inverse relationship has no identifiable leader');
  assert.equal(report.pairs[0].directions.length, 6, 'both directions and three lags are reported');
  assert.equal(report.pairs[0].leader, null, 'no arbitrary winner is picked for a symmetric pair');
});

test('an asymmetric lead is attributed to the leading venue by directional tests', () => {
  const signal = Array.from({ length: 160 }, (_, i) => Math.sin(i / 4) * 0.01);
  const a: FactorSample[] = [], b: FactorSample[] = [];
  let pa = 100, pb = 100;
  for (let i = 0; i < signal.length; i += 1) {
    // A = signal + unique noise; B next step = lagged signal + different noise, so A→B
    // is stronger than B→A.
    if (i > 0) {
      pa *= 1 + signal[i - 1] + 0.006 * Math.sin(i * 3.1);
      pb *= 1 + 0.9 * signal[i - 2 >= 0 ? i - 2 : 0] + 0.006 * Math.sin(i * 7.3);
    }
    const time = T0 + i * STEP;
    a.push({ venue: 'binance', factor: 'oi_delta', time, availableAt: time, value: pa, unit: 'pct', coveragePct: 100 });
    b.push({ venue: 'bybit', factor: 'oi_delta', time, availableAt: time, value: pb, unit: 'pct', coveragePct: 100 });
  }
  const report = buildFactorEvidence('oi_delta', [...a, ...b], opts);
  assert.equal(report.leader, 'binance', 'the stronger directional test wins, never the correlation sign');
  assert.equal(report.follower, 'bybit');
  assert.ok(report.directions.filter((direction) => direction.selected).length === 1);
});

test('decisions are matched once and only use data available at decision time', () => {
  const { a, b } = inverseLead(60);
  const report = buildFactorEvidence('oi_delta', [...a, ...b], opts);
  for (const direction of report.directions) {
    assert.ok(direction.samples <= b.length);
    assert.ok(direction.samples <= a.length);
  }

  const late = a.map((sample) => ({ ...sample, availableAt: T0 + 10_000_000 }));
  const blocked = buildFactorEvidence('oi_delta', [...late, ...b], opts);
  const forward = blocked.pairs[0].directions.filter((direction) => direction.from === 'binance');
  assert.ok(forward.length > 0);
  assert.ok(forward.every((direction) => direction.samples === 0), 'late-available A data must not enter a decision');
});

test('irregular sampling is aligned by timestamps, not by array index', () => {
  const irregular: FactorSample[] = [];
  let price = 100;
  for (let i = 0; i < 80; i += 1) {
    const time = T0 + i * STEP + (i % 3) * 17_000;
    price *= 1 + (i % 2 === 0 ? 0.01 : -0.01);
    irregular.push({ venue: 'binance', factor: 'oi_delta', time, availableAt: time, value: price, unit: 'pct', coveragePct: 100 });
  }
  const follow = irregular.map((sample) => ({ ...sample, venue: 'bybit', time: sample.time + 7_000, availableAt: sample.availableAt + 7_000 }));
  const report = buildFactorEvidence('oi_delta', [...irregular, ...follow], opts);
  assert.equal(report.comparable, true);
  assert.ok(report.pairs.some((pair) => pair.directions.some((direction) => direction.samples > 0)));
});

test('mixed units, low coverage, large gaps and missing values are refused', () => {
  const { a, b } = inverseLead(40);
  const mixed = buildFactorEvidence('oi_delta', [...a, ...b.map((sample) => ({ ...sample, unit: 'bps' }))], opts);
  assert.equal(mixed.verdict, 'unavailable');
  assert.match(mixed.reasons[0], /Mixed units/);

  const lowCoverage = buildFactorEvidence('oi_delta', [...a, ...b].map((sample) => ({ ...sample, coveragePct: 10 })), opts);
  assert.equal(lowCoverage.comparable, false);

  const gappy = a.map((sample, index) => ({ ...sample, time: T0 + index * 20 * 60_000 }));
  const gapReport = buildFactorEvidence('oi_delta', [...gappy, ...b], opts);
  assert.equal(gapReport.comparable, false);
  assert.match(gapReport.reasons.join(' '), /gaps/);

  const missing = buildFactorEvidence('oi_delta', [...a, ...b].map((sample) => ({ ...sample, value: null })), opts);
  assert.equal(missing.verdict, 'unavailable');
});

test('OI level and OI delta stay distinct factors with distinct units', () => {
  const samples = factorSamplesFromSnapshots([
    { ingestTime: T0 + 1_000, payload: { snapshots: [{ exchange: 'binance', price: 100, markPrice: 100.1, oiBase: 5_000, fundingRate: 0.0001, eventTime: T0 }] } },
    { ingestTime: T0 + 61_000, payload: { snapshots: [{ exchange: 'binance', price: 101, markPrice: 101.2, oiBase: 5_500, fundingRate: 0.0001, eventTime: T0 + 60_000 }] } },
  ]);
  const level = samples.filter((sample) => sample.factor === 'oi_level');
  const delta = samples.filter((sample) => sample.factor === 'oi_delta');
  assert.equal(level.length, 2);
  assert.equal(delta.length, 1);
  assert.equal(level[0].unit, 'base');
  assert.equal(delta[0].unit, 'pct');
  assert.equal(delta[0].value, 10);
});
