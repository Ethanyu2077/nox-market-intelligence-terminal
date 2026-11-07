import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLeadLag } from '../server/leadlag.ts';
import type { PriceSample } from '../shared/leadlag.ts';

/** A leads B: A's return over the last step predicts B's next step. */
function synthetic(n = 300): { a: PriceSample[]; b: PriceSample[] } {
  const a: PriceSample[] = [], b: PriceSample[] = [];
  let priceA = 100, priceB = 100;
  for (let i = 0; i < n; i += 1) {
    const time = 1_700_000_000_000 + i * 60_000;
    const move = Math.sin(i / 3) > 0 ? 0.001 : -0.001;
    priceA *= 1 + move;
    // B follows A's move one step later.
    priceB *= 1 + (i > 0 ? (Math.sin((i - 1) / 3) > 0 ? 0.001 : -0.001) : 0);
    a.push({ venue: 'a', time, availableAt: time, price: priceA });
    b.push({ venue: 'b', time, availableAt: time, price: priceB });
  }
  return { a, b };
}

test('lead-lag detects a planted one-step lead on the holdout', () => {
  const { a, b } = synthetic();
  const report = analyzeLeadLag({ venueA: 'binance', venueB: 'bybit', samplesA: a, samplesB: b }, { windowMs: 60_000, horizonMs: 60_000, minSamples: 20, maxDelayMs: 5_000, bootstrapRounds: 50 });
  assert.ok(report.selectedLagMs != null);
  assert.ok(report.holdout.samples >= 20);
  assert.equal(report.baselines.length, 2);
  assert.ok(report.holdout.uncertainty.meanNetPct != null);
  // Whatever the statistics say, the verdict can never exceed descriptive research.
  assert.ok(['descriptive', 'promising-not-tradable'].includes(report.verdict));
});

test('forward outcomes are never taken from data that was not observable yet', () => {
  const { a, b } = synthetic(120);
  // Truncate B one step before the end: the last decisions have no observable future.
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b.slice(0, 100) }, { minSamples: 10, maxDelayMs: 5_000, bootstrapRounds: 20 });
  assert.ok(report.coverage.excludedNoFuture > 0, 'decisions without a future price must be excluded');
  assert.equal(report.holdout.samples + report.coverage.trainSamples + report.coverage.excludedNoFuture + report.coverage.excludedNoPrior, b.slice(0, 100).length);
});

test('delayed samples are excluded and reported', () => {
  const { a, b } = synthetic(120);
  const delayedB = b.map((sample, index) => index < 10 ? { ...sample, availableAt: sample.time + 60_000 } : sample);
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: delayedB }, { maxDelayMs: 5_000, minSamples: 10, bootstrapRounds: 10 });
  const row = report.availability.find((item) => item.venue === 'b');
  assert.equal(row?.excludedDelayed, 10);
});

test('insufficient samples withhold any edge claim', () => {
  const { a, b } = synthetic(30);
  const report = analyzeLeadLag({ venueA: 'a', venueB: 'b', samplesA: a, samplesB: b }, { minSamples: 100 });
  assert.equal(report.verdict, 'insufficient');
  assert.ok(report.notes.some((note) => /Insufficient samples/.test(note)));
  assert.equal(report.holdout.uncertainty.hitRate, null);
});
