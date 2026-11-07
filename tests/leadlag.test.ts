import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLeadLag } from '../server/leadlag.ts';
import type { PriceSample } from '../shared/leadlag.ts';

function synthetic(n = 400): { a: PriceSample[]; b: PriceSample[] } {
  const a: PriceSample[] = [], b: PriceSample[] = [];
  let priceA = 100, priceB = 100;
  for (let i = 0; i < n; i += 1) {
    const time = 1_700_000_000_000 + i * 60_000;
    const move = Math.sin(i / 3) > 0 ? 0.001 : -0.001;
    priceA *= 1 + move;
    priceB *= 1 + (i > 0 ? (Math.sin((i - 1) / 3) > 0 ? 0.001 : -0.001) : 0);
    a.push({ venue: 'a', time, receivedAt: time, availableAt: time, price: priceA });
    b.push({ venue: 'b', time, receivedAt: time, availableAt: time, price: priceB });
  }
  return { a, b };
}

test('walk-forward produces out-of-sample folds and a capped verdict', () => {
  const { a, b } = synthetic();
  const report = analyzeLeadLag({ venueA: 'binance', venueB: 'bybit', samplesA: a, samplesB: b }, { windowMs: 120_000, horizonMs: 60_000, minSamples: 20, maxDelayMs: 5_000, bootstrapRounds: 50, folds: 3 });
  assert.equal(report.folds.length, 3);
  for (const fold of report.folds) {
    assert.ok(fold.trainEnd <= fold.testStart);
    assert.ok(fold.purgedTrain >= 0);
    assert.ok(fold.outcomeCutoff === fold.testEnd);
    assert.ok(fold.selectedLagMs != null && fold.selectedLagMs >= 0, 'each fold records its own selected lag');
    assert.ok(fold.baselines && 'momentum' in fold.baselines && 'alwaysLong' in fold.baselines && 'randomized' in fold.baselines);
  }
  assert.equal(report.folds.reduce((sum, fold) => sum + fold.censored, 0), report.coverage.censored);
  assert.ok(report.outOfSample.samples >= 20);
  assert.ok(report.outOfSample.uncertainty.hitRate != null);
  assert.equal(report.baselines.length, 3);
  for (const baseline of report.baselines) assert.equal(baseline.samples, report.outOfSample.samples, 'all baselines share the strategy OOS set');
  assert.ok(['descriptive', 'promising-not-tradable'].includes(report.verdict));
  assert.ok(report.multipleTesting.lagsTested >= 1);
  assert.match(report.notes.join(' '), /Multiple testing/);
});

test('lag definitions differ: a positive lag moves the lead window into the past', () => {
  const { a, b } = synthetic(200);
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b }, { windowMs: 60_000, horizonMs: 60_000, minSamples: 10, maxLags: 2, bootstrapRounds: 10, folds: 2 });
  const zero = report.lags.find((lag) => lag.lagMs === 0);
  const one = report.lags.find((lag) => lag.lagMs === 60_000);
  assert.ok(zero?.aWindowEnd != null && one?.aWindowEnd != null);
  assert.ok((one!.aWindowEnd as number) < (zero!.aWindowEnd as number), 'lag>0 uses an earlier A observation');
});

test('future outcomes are never taken from data that was not observable', () => {
  const { a, b } = synthetic(150);
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b.slice(0, 120) }, { minSamples: 10, maxDelayMs: 5_000, bootstrapRounds: 10, folds: 2 });
  assert.ok(report.coverage.excludedNoFuture > 0);
  assert.ok(report.outOfSample.samples < 120);
});

test('delayed samples are excluded and reported', () => {
  const { a, b } = synthetic(150);
  const delayed = b.map((sample, index) => index < 12 ? { ...sample, availableAt: sample.time + 60_000 } : sample);
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: delayed }, { maxDelayMs: 5_000, minSamples: 10, bootstrapRounds: 10, folds: 2 });
  assert.equal(report.availability.find((row) => row.venue === 'b')?.excludedDelayed, 12);
});

test('insufficient samples withhold any edge claim', () => {
  const { a, b } = synthetic(30);
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b }, { minSamples: 100 });
  assert.equal(report.verdict, 'insufficient');
  assert.ok(['insufficient', 'descriptive'].includes(report.verdict));
  assert.ok(report.notes.some((note) => /Insufficient out-of-sample/.test(note)));
});

test('outcomes that happened in time but arrived after the cutoff are censored', () => {
  const rows = (delayMs: number) => {
    const a: PriceSample[] = [], b: PriceSample[] = [];
    let priceA = 100, priceB = 100;
    for (let i = 0; i < 400; i += 1) {
      const time = 1_700_000_000_000 + i * 60_000;
      priceA *= 1 + Math.sin(i / 4) * 0.001;
      priceB *= 1 + Math.sin((i - 1) / 4) * 0.001;
      a.push({ venue: 'a', time, receivedAt: time + delayMs, availableAt: time + delayMs, price: priceA });
      b.push({ venue: 'b', time, receivedAt: time + delayMs, availableAt: time + delayMs, price: priceB });
    }
    return { a, b };
  };
  const { a, b } = rows(15 * 60_000);
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b }, { minSamples: 10, horizonMs: 5 * 60_000, folds: 4, maxDelayMs: 20 * 60_000, bootstrapRounds: 20 });
  assert.ok(report.coverage.censored > 0, 'boundary censoring must be recorded');
  assert.ok(report.coverage.censoredLate > 0, 'late-arriving outcomes are a distinct censoring reason');
  assert.equal(report.outOfSample.samples, 0, 'no unavailable outcome enters the OOS statistics');
  assert.equal(report.verdict, 'insufficient');
  assert.equal(report.folds.reduce((sum, fold) => sum + fold.censoredLate, 0), report.coverage.censoredLate);
});

test('duplicate and out-of-order samples do not change the research result', () => {
  const { a, b } = synthetic(240);
  const clean = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b }, { minSamples: 10, bootstrapRounds: 20, folds: 2 });
  const shuffled = [...a].reverse().concat([...a.slice(0, 5), ...a.slice(0, 5)]);
  const shuffledB = [...b].reverse().concat(b.slice(0, 3));
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: shuffled, samplesB: shuffledB }, { minSamples: 10, bootstrapRounds: 20, folds: 2 });
  assert.equal(report.outOfSample.samples, clean.outOfSample.samples);
  assert.equal(report.coverage.censored, clean.coverage.censored);
  assert.equal(report.folds.length, clean.folds.length);
});

test('a delayed venue is not usable before its values arrive', () => {
  const { a, b } = synthetic(240);
  const lateA = a.map((sample) => ({ ...sample, availableAt: sample.time + 20 * 60_000 }));
  const clean = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b }, { minSamples: 10, bootstrapRounds: 10, folds: 2 });
  const delayed = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: lateA, samplesB: b }, { minSamples: 10, bootstrapRounds: 10, folds: 2 });
  assert.ok(delayed.coverage.paired <= clean.coverage.paired, 'delayed lead data cannot increase usable decisions');
});
