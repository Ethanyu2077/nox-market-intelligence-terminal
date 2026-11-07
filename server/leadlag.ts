import type { Baseline, FoldResult, LagScore, LeadLagInput, LeadLagOptions, LeadLagReport, PriceSample, Uncertainty } from '../shared/leadlag.ts';

/**
 * Cross-venue lead-lag research.
 *
 * Time semantics are explicit and enforced:
 *  - a decision at t may only use samples with `availableAt <= t`;
 *  - a forward outcome must have `time > t` and `availableAt > t` (no future leak);
 *  - for lag L >= 0, A's return window ends at `t - L` (A moved first), B's return is
 *    measured forwards from t. Negative lags are not evaluated: they would require A data
 *    from after the decision, which is leakage. The reverse direction is a separate call.
 *
 * Validation is purged walk-forward: each test window uses an expanding training window,
 * overlapping outcomes are purged and an embargo equal to the horizon is applied.
 */

export const DEFAULT_LEADLAG_OPTIONS: LeadLagOptions = {
  windowMs: 5 * 60_000,
  horizonMs: 5 * 60_000,
  maxLags: 6,
  lagStepMs: 60_000,
  maxDelayMs: 10_000,
  minSamples: 60,
  costBpsPerSide: 5,
  bootstrapRounds: 200,
  folds: 4,
};

interface Pair { decisionTime: number; leadReturn: number; forwardReturn: number; priorReturn: number | null }

function normalize(samples: PriceSample[]): PriceSample[] {
  return [...samples]
    .map((sample) => ({ ...sample, receivedAt: sample.receivedAt ?? sample.time, availableAt: Math.max(sample.availableAt, sample.receivedAt ?? sample.time) }))
    .sort((a, b) => a.time - b.time);
}

function lastKnown(samples: PriceSample[], at: number, cutoff: number): PriceSample | null {
  let best: PriceSample | null = null;
  for (const sample of samples) {
    if (sample.time > at) break;
    if (sample.availableAt > cutoff) continue;
    best = sample;
  }
  return best;
}

function lastBetween(samples: PriceSample[], from: number, to: number, decisionAt: number): PriceSample | null {
  let best: PriceSample | null = null;
  for (const sample of samples) {
    if (sample.time <= from) continue;
    if (sample.time > to) break;
    if (sample.availableAt <= decisionAt) continue;
    if (!best || sample.time > best.time) best = sample;
  }
  return best;
}

function buildPairs(a: PriceSample[], b: PriceSample[], options: LeadLagOptions, lagMs: number): { pairs: Pair[]; noFuture: number; noPrior: number; delayed: number } {
  const pairs: Pair[] = [];
  let noFuture = 0, noPrior = 0, delayed = 0;
  for (const sample of b) {
    if (sample.availableAt - sample.time > options.maxDelayMs) { delayed += 1; continue; }
    // The decision can only happen once the follower value is actually usable locally.
    const decision = sample.availableAt;
    const aEnd = lastKnown(a, decision - lagMs, decision);
    const aStart = aEnd ? lastKnown(a, aEnd.time - options.windowMs, decision) : null;
    if (!aEnd || !aStart || aStart.time >= aEnd.time) { noPrior += 1; continue; }
    const future = lastBetween(b, decision, decision + options.horizonMs, decision);
    if (!future) { noFuture += 1; continue; }
    const priorB = lastKnown(b, decision - options.windowMs, decision);
    pairs.push({
      decisionTime: decision,
      leadReturn: aEnd.price / aStart.price - 1,
      forwardReturn: future.price / sample.price - 1,
      priorReturn: priorB && priorB.time < sample.time ? (sample.price - priorB.price) / priorB.price : null,
    });
  }
  return { pairs, noFuture, noPrior, delayed };
}

function pearson(pairs: Pair[]): number | null {
  if (pairs.length < 3) return null;
  const n = pairs.length;
  const mx = pairs.reduce((sum, pair) => sum + pair.leadReturn, 0) / n;
  const my = pairs.reduce((sum, pair) => sum + pair.forwardReturn, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const pair of pairs) { const x = pair.leadReturn - mx, y = pair.forwardReturn - my; num += x * y; dx += x * x; dy += y * y; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function netReturns(pairs: Pair[], costBpsPerSide: number): number[] {
  const cost = (costBpsPerSide * 2) / 10_000;
  return pairs.map((pair) => Math.sign(pair.leadReturn) * pair.forwardReturn - cost).filter((value) => Number.isFinite(value));
}

function stats(returns: number[]): { samples: number; hitRate: number | null; meanNetPct: number | null } {
  if (!returns.length) return { samples: 0, hitRate: null, meanNetPct: null };
  return {
    samples: returns.length,
    hitRate: returns.filter((value) => value > 0).length / returns.length,
    meanNetPct: returns.reduce((sum, value) => sum + value, 0) / returns.length * 100,
  };
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
}

/** Moving block bootstrap (blocks preserve short-range dependence, unlike iid resampling). */
function blockBootstrap(returns: number[], rounds: number): Uncertainty {
  const n = returns.length;
  const blockSize = Math.max(2, Math.round(Math.sqrt(n)));
  if (n < 10) return { hitRate: null, meanNetPct: null, blockSize };
  let seed = 1234567;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const hitRates: number[] = [], means: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const sample: number[] = [];
    while (sample.length < n) {
      const start = Math.floor(random() * n);
      for (let i = 0; i < blockSize && sample.length < n; i += 1) sample.push(returns[(start + i) % n]);
    }
    hitRates.push(sample.filter((value) => value > 0).length / sample.length);
    means.push(sample.reduce((sum, value) => sum + value, 0) / sample.length * 100);
  }
  return { hitRate: [quantile(hitRates, 0.025), quantile(hitRates, 0.975)], meanNetPct: [quantile(means, 0.025), quantile(means, 0.975)], blockSize };
}

/** Effective sample size from lag-1 autocorrelation (conservative for overlapping returns). */
function effectiveSamples(returns: number[]): number | null {
  const n = returns.length;
  if (n < 10) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) { den += (returns[i] - mean) ** 2; if (i > 0) num += (returns[i] - mean) * (returns[i - 1] - mean); }
  if (den === 0) return null;
  const rho = num / den;
  return Math.max(1, n * (1 - rho) / (1 + rho));
}

function selectLag(a: PriceSample[], b: PriceSample[], options: LeadLagOptions, trainEnd: number): { lagMs: number | null; scores: LagScore[] } {
  const scores: LagScore[] = [];
  let best: { lagMs: number; value: number } | null = null;
  for (let lag = 0; lag <= options.maxLags; lag += 1) {
    const lagMs = lag * options.lagStepMs;
    const { pairs } = buildPairs(a, b, options, lagMs);
    // Purge training outcomes that would overlap the test window.
    const train = pairs.filter((pair) => pair.decisionTime + options.horizonMs + lagMs < trainEnd);
    const correlation = pearson(train);
    const reference = b.find((sample) => sample.availableAt - sample.time <= options.maxDelayMs)?.time ?? null;
    scores.push({ lagMs, correlation, samples: train.length, aWindowEnd: reference == null ? null : reference - lagMs, bWindowStart: reference });
    if (correlation != null && (!best || Math.abs(correlation) > best.value)) best = { lagMs, value: Math.abs(correlation) };
  }
  return { lagMs: best?.lagMs ?? null, scores };
}

function walkForward(a: PriceSample[], b: PriceSample[], options: LeadLagOptions): { folds: FoldResult[]; oosPairs: Pair[]; selectedLagMs: number | null; lagsTested: number } {
  const times = a.map((sample) => sample.time).concat(b.map((sample) => sample.time)).sort((x, y) => x - y);
  if (!times.length) return { folds: [], oosPairs: [], selectedLagMs: null, lagsTested: options.maxLags + 1 };
  const start = times[0], end = times[times.length - 1];
  const folds: FoldResult[] = [];
  const oosPairs: Pair[] = [];
  const foldCount = Math.max(2, options.folds);
  let selectedLagMs: number | null = null;
  for (let index = 1; index <= foldCount; index += 1) {
    const testStart = start + (end - start) * (index / (foldCount + 1));
    const testEnd = start + (end - start) * ((index + 1) / (foldCount + 1));
    const trainEnd = testStart - options.horizonMs; // embargo
    const selection = selectLag(a, b, options, trainEnd);
    const lag = selection.lagMs ?? 0;
    selectedLagMs = selectedLagMs ?? selection.lagMs;
    const { pairs } = buildPairs(a, b, options, lag);
    // Purge training outcomes that reach into the test window.
    const trainAll = pairs.filter((pair) => pair.decisionTime < trainEnd);
    const train = trainAll.filter((pair) => pair.decisionTime + options.horizonMs + lag < trainEnd);
    // Strategy and all baselines share one common decision set: a missing momentum input
    // removes the decision from every side, so hit rates are always comparable.
    const test = pairs.filter((pair) => pair.decisionTime >= testStart && pair.decisionTime < testEnd && pair.priorReturn != null);
    oosPairs.push(...test);
    folds.push({
      trainStart: times[0], trainEnd,
      testStart, testEnd,
      purgedTrain: trainAll.length - train.length,
      trainSamples: train.length,
      testSamples: test.length,
      selectedLagMs: selection.lagMs,
      ...stats(netReturns(test, options.costBpsPerSide)),
    });
  }
  return { folds, oosPairs, selectedLagMs, lagsTested: options.maxLags + 1 };
}

function baseline(name: string, returns: number[]): Baseline { return { name, ...stats(returns) }; }

export function analyzeLeadLag(input: LeadLagInput, overrides: Partial<LeadLagOptions> = {}, now = Date.now()): LeadLagReport {
  const options: LeadLagOptions = { ...DEFAULT_LEADLAG_OPTIONS, ...overrides };
  const a = normalize(input.samplesA);
  const b = normalize(input.samplesB);
  const delayedA = a.filter((sample) => sample.availableAt - sample.time > options.maxDelayMs).length;
  const delayedB = b.filter((sample) => sample.availableAt - sample.time > options.maxDelayMs).length;
  const delays = (rows: PriceSample[]) => rows.filter((sample) => sample.availableAt - sample.time <= options.maxDelayMs).map((sample) => sample.availableAt - sample.time);

  const { folds, oosPairs, selectedLagMs, lagsTested } = walkForward(a, b, options);
  const oosReturns = netReturns(oosPairs, options.costBpsPerSide);
  const oos = stats(oosReturns);
  const uncertainty = blockBootstrap(oosReturns, options.bootstrapRounds);
  const effective = effectiveSamples(oosReturns);

  const sampleTimes = [...a, ...b].map((sample) => sample.time).sort((x, y) => x - y);
  const splitRef = sampleTimes.length ? sampleTimes[0] + (sampleTimes[sampleTimes.length - 1] - sampleTimes[0]) * 0.7 : now;
  const base = buildPairs(a, b, options, selectedLagMs ?? 0);
  const all = base.pairs;
  const momentum: number[] = [];
  const randomized: number[] = [];
  const alwaysLong: number[] = [];
  let seed = 99;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const cost = (options.costBpsPerSide * 2) / 10_000;
  // All baselines use exactly the same out-of-sample decision set as the strategy.
  for (const pair of oosPairs) {
    alwaysLong.push(pair.forwardReturn - cost);
    randomized.push((random() < 0.5 ? -1 : 1) * pair.forwardReturn - cost);
    momentum.push(Math.sign(pair.priorReturn as number) * pair.forwardReturn - cost);
  }
  const baselines = [baseline('momentum', momentum), baseline('always-long', alwaysLong), baseline('randomized', randomized)];
  const bestBaseline = Math.max(...baselines.map((row) => row.hitRate ?? 0));
  const lift = oos.hitRate != null ? oos.hitRate - bestBaseline : null;
  const consistent = folds.filter((fold) => fold.hitRate != null && fold.hitRate > 0.5).length >= Math.ceil(folds.length * 0.75);
  const ciStable = uncertainty.hitRate != null && uncertainty.hitRate[0] > 0.5 && uncertainty.meanNetPct != null && uncertainty.meanNetPct[0] > 0;
  const enough = oos.samples >= options.minSamples && folds.filter((fold) => fold.testSamples > 0).length >= 2;
  const verdict: LeadLagReport['verdict'] = !enough ? 'insufficient' : lift != null && lift > 0.03 && ciStable && consistent ? 'promising-not-tradable' : 'descriptive';

  const sensitivity = [0.5, 1, 2].map((factor) => {
    const windowMs = Math.round(options.windowMs * factor);
    const variant = walkForward(a, b, { ...options, windowMs });
    return { windowMs, selectedLagMs: variant.selectedLagMs, oosHitRate: stats(netReturns(variant.oosPairs, options.costBpsPerSide)).hitRate };
  });

  const notes: string[] = [];
  if (!enough) notes.push(`Insufficient out-of-sample evidence: ${oos.samples} OOS samples (minimum ${options.minSamples}) across ${folds.filter((fold) => fold.testSamples > 0).length} folds. No edge is claimed.`);
  notes.push(`Multiple testing: ${lagsTested} lags were compared; a naive 5% threshold is not appropriate (Bonferroni alpha ${(0.05 / lagsTested).toFixed(4)}).`);
  notes.push('Moving-block bootstrap preserves short-range dependence; the interval still assumes a stable regime and is not a guarantee.');
  notes.push('Availability comes from local ingest timestamps, not venue clocks; feed delay is measured per sample.');
  notes.push('Lead-lag is a statistical association on public data, not evidence of causality or executable edge; fees, queue position, latency and capacity are not modelled.');
  notes.push('Negative lags are not evaluated: they would require post-decision A data and leak the future. Use the reversed pair instead.');

  return {
    generatedAt: now,
    pair: `${input.venueA}->${input.venueB}`,
    options,
    timeSemantics: {
      decisionUses: 'availableAt <= decision time',
      outcomeRequires: 'time > decision && availableAt > decision',
      lagDirection: 'A leads B for lag >= 0; negative lags are not evaluated (they would leak)',
    },
    availability: [
      { venue: input.venueA, samples: a.length, medianDelayMs: quantile(delays(a), 0.5) ?? null, p95DelayMs: quantile(delays(a), 0.95) ?? null, excludedDelayed: delayedA },
      { venue: input.venueB, samples: b.length, medianDelayMs: quantile(delays(b), 0.5) ?? null, p95DelayMs: quantile(delays(b), 0.95) ?? null, excludedDelayed: delayedB },
    ],
    coverage: {
      totalDecisions: b.length,
      paired: all.length,
      excludedNoFuture: base.noFuture,
      excludedNoPrior: base.noPrior,
      excludedDelayed: base.delayed,
      effectiveSamples: effective,
    },
    lags: selectLag(a, b, options, splitRef).scores,
    folds,
    outOfSample: { ...oos, uncertainty },
    baselines,
    sensitivity,
    multipleTesting: { lagsTested, bonferroniAlpha: 0.05 / Math.max(1, lagsTested), note: 'Lag selection and thresholds are chosen on training folds only; the reported interval is out-of-sample.' },
    verdict,
    notes,
  };
}
