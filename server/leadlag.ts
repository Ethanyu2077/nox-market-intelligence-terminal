import type { Baseline, LagScore, LeadLagInput, LeadLagOptions, LeadLagReport, PriceSample } from '../shared/leadlag.ts';

/**
 * Cross-venue lead-lag research.
 *
 * Rules enforced here:
 *  - a sample may only be used once its `availableAt` has passed (no ingest-time leakage);
 *  - forward outcomes require data strictly after the decision time (no future leak);
 *  - lag/parameter selection happens on the first 70% (train); the last 30% is holdout;
 *  - results are compared with simple baselines and reported with bootstrap intervals;
 *  - the verdict can never be "tradable": at best "promising-not-tradable".
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
};

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

/** Nearest sample at or before `time`, but only if it was already available. */
function lastKnown(samples: PriceSample[], time: number, cutoff = time): PriceSample | null {
  let best: PriceSample | null = null;
  for (const sample of samples) {
    if (sample.availableAt > cutoff) continue;
    if (sample.time > time) continue;
    if (!best || sample.time > best.time) best = sample;
  }
  return best;
}

function forward(samples: PriceSample[], from: number, to: number, decisionAt: number): PriceSample | null {
  let best: PriceSample | null = null;
  for (const sample of samples) {
    // The outcome must be observable strictly after the decision: event time and ingest time
    // both have to be in the future, otherwise the result is a leak.
    if (sample.time <= from || sample.availableAt <= decisionAt) continue;
    if (sample.time > to) break;
    best = sample;
  }
  return best;
}

interface Pair { decisionTime: number; availableAt: number; leadReturn: number; forwardReturn: number }

function buildPairs(input: LeadLagInput, options: LeadLagOptions, lagMs: number): { pairs: Pair[]; excludedNoFuture: number; excludedNoPrior: number } {
  const pairs: Pair[] = [];
  let excludedNoFuture = 0, excludedNoPrior = 0;
  for (const b of input.samplesB) {
    if (b.availableAt - b.time > options.maxDelayMs) continue;
    const decisionTime = b.time;
    const priorA = lastKnown(input.samplesA, decisionTime - (lagMs > 0 ? 0 : Math.abs(lagMs)), decisionTime);
    const priorA0 = priorA ? lastKnown(input.samplesA, priorA.time - options.windowMs, decisionTime) : null;
    const priorB = lastKnown(input.samplesB, decisionTime - options.windowMs, decisionTime);
    if (!priorA || !priorA0 || !priorB) { excludedNoPrior += 1; continue; }
    const futureB = forward(input.samplesB, decisionTime, decisionTime + options.horizonMs + Math.max(0, lagMs), decisionTime);
    if (!futureB) { excludedNoFuture += 1; continue; }
    const leadReturn = (priorA.price - priorA0.price) / priorA0.price;
    const forwardReturn = (futureB.price - b.price) / b.price;
    pairs.push({ decisionTime, availableAt: Math.max(priorA.availableAt, b.availableAt), leadReturn, forwardReturn });
  }
  return { pairs, excludedNoFuture, excludedNoPrior };
}

function pearson(pairs: Pair[]): number | null {
  if (pairs.length < 3) return null;
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p.leadReturn, 0) / n;
  const my = pairs.reduce((s, p) => s + p.forwardReturn, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const p of pairs) { const a = p.leadReturn - mx, b = p.forwardReturn - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function tradeStats(pairs: Pair[], costBpsPerSide: number): { samples: number; hitRate: number | null; meanNetPct: number | null; returns: number[] } {
  const cost = (costBpsPerSide * 2) / 10_000;
  const returns = pairs.map((p) => Math.sign(p.leadReturn) * p.forwardReturn - cost).filter((value) => Number.isFinite(value));
  if (!returns.length) return { samples: 0, hitRate: null, meanNetPct: null, returns: [] };
  return {
    samples: returns.length,
    hitRate: returns.filter((value) => value > 0).length / returns.length,
    meanNetPct: returns.reduce((s, v) => s + v, 0) / returns.length * 100,
    returns,
  };
}

function bootstrap(returns: number[], rounds: number): { hitRate: [number, number] | null; meanNetPct: [number, number] | null } {
  if (returns.length < 10) return { hitRate: null, meanNetPct: null };
  let seed = 42;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const hitRates: number[] = [], means: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const sample: number[] = [];
    for (let i = 0; i < returns.length; i += 1) sample.push(returns[Math.floor(random() * returns.length)]);
    hitRates.push(sample.filter((value) => value > 0).length / sample.length);
    means.push(sample.reduce((s, v) => s + v, 0) / sample.length * 100);
  }
  return { hitRate: [quantile(hitRates, 0.025) ?? 0, quantile(hitRates, 0.975) ?? 0], meanNetPct: [quantile(means, 0.025) ?? 0, quantile(means, 0.975) ?? 0] };
}

export function analyzeLeadLag(input: LeadLagInput, overrides: Partial<LeadLagOptions> = {}, now = Date.now()): LeadLagReport {
  const options: LeadLagOptions = { ...DEFAULT_LEADLAG_OPTIONS, ...overrides };
  const notes: string[] = [];
  const delayedA = input.samplesA.filter((s) => s.availableAt - s.time > options.maxDelayMs).length;
  const delayedB = input.samplesB.filter((s) => s.availableAt - s.time > options.maxDelayMs).length;
  const delaysA = input.samplesA.filter((s) => s.availableAt - s.time <= options.maxDelayMs).map((s) => s.availableAt - s.time);
  const delaysB = input.samplesB.filter((s) => s.availableAt - s.time <= options.maxDelayMs).map((s) => s.availableAt - s.time);

  // Train/holdout split by decision time (first 70% by time, not by sample count).
  const times = [...input.samplesB.map((s) => s.time)].sort((a, b) => a - b);
  const splitTime = times.length ? times[Math.floor(times.length * 0.7)] : now;

  const lags: LagScore[] = [];
  let selectedLagMs: number | null = null;
  let bestCorrelation = -Infinity;
  for (let i = -options.maxLags; i <= options.maxLags; i += 1) {
    const lagMs = i * options.lagStepMs;
    const { pairs } = buildPairs(input, options, lagMs);
    const train = pairs.filter((p) => p.decisionTime < splitTime);
    const correlation = pearson(train);
    lags.push({ lagMs, correlation, samples: train.length });
    if (correlation != null && Math.abs(correlation) > bestCorrelation) { bestCorrelation = Math.abs(correlation); selectedLagMs = lagMs; }
  }

  const all = buildPairs(input, options, selectedLagMs ?? 0);
  const trainPairs = all.pairs.filter((p) => p.decisionTime < splitTime);
  const holdoutPairs = all.pairs.filter((p) => p.decisionTime >= splitTime);
  const holdout = tradeStats(holdoutPairs, options.costBpsPerSide);
  const uncertainty = bootstrap(holdout.returns, options.bootstrapRounds);

  const cost = (options.costBpsPerSide * 2) / 10_000;
  const baseline = (name: string, returns: number[]): Baseline => ({
    name,
    samples: returns.length,
    hitRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    meanNetPct: returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length * 100 : null,
  });
  const momentumReturns = holdoutPairs.map((p) => {
    const prior = lastKnown(input.samplesB, p.decisionTime - options.windowMs, p.decisionTime);
    const current = lastKnown(input.samplesB, p.decisionTime, p.decisionTime);
    return prior && current ? Math.sign(current.price - prior.price) * p.forwardReturn - cost : NaN;
  }).filter((value) => Number.isFinite(value));
  const alwaysLong = holdoutPairs.map((p) => p.forwardReturn - cost);

  const sensitivity = [0.5, 1, 2].map((factor) => {
    const windowMs = Math.round(options.windowMs * factor);
    const { pairs } = buildPairs({ ...input, samplesA: input.samplesA }, { ...options, windowMs }, selectedLagMs ?? 0);
    const hold = pairs.filter((p) => p.decisionTime >= splitTime);
    return { windowMs, selectedLagMs, holdoutHitRate: tradeStats(hold, options.costBpsPerSide).hitRate };
  });

  const enough = holdout.samples >= options.minSamples && trainPairs.length >= options.minSamples;
  const lift = holdout.hitRate != null && baseline('momentum', momentumReturns).hitRate != null
    ? holdout.hitRate - (baseline('momentum', momentumReturns).hitRate ?? 0)
    : null;
  const ciStable = uncertainty.hitRate != null && uncertainty.hitRate[0] > 0.5;
  const sensitivityStable = sensitivity.every((row) => row.holdoutHitRate != null && Math.abs(row.holdoutHitRate - (holdout.hitRate ?? 0)) < 0.1);
  const verdict: LeadLagReport['verdict'] = !enough
    ? 'insufficient'
    : lift != null && lift > 0.05 && ciStable && sensitivityStable ? 'promising-not-tradable' : 'descriptive';

  if (!enough) notes.push(`Insufficient samples: ${holdout.samples} holdout / ${trainPairs.length} train (minimum ${options.minSamples} each). No edge is claimed.`);
  if (delayedA || delayedB) notes.push(`Excluded ${delayedA + delayedB} samples with availability delay above ${options.maxDelayMs}ms.`);
  if (all.excludedNoFuture) notes.push(`Excluded ${all.excludedNoFuture} decisions without an observable forward price (no future leak).`);
  if (verdict === 'promising-not-tradable') notes.push('Lift over baseline and a stable CI were observed, but this is still descriptive research: fees, queue position, latency and regime change are not modelled.');
  notes.push('Availability timestamps come from local ingest, not the venue clock; feed delay is measured per sample, never assumed zero.');
  notes.push('No execution, position sizing or order routing is implied by this report.');

  return {
    generatedAt: now,
    pair: `${input.venueA}->${input.venueB}`,
    options,
    availability: [
      { venue: input.venueA, samples: input.samplesA.length, medianDelayMs: quantile(delaysA, 0.5), p95DelayMs: quantile(delaysA, 0.95), excludedDelayed: delayedA },
      { venue: input.venueB, samples: input.samplesB.length, medianDelayMs: quantile(delaysB, 0.5), p95DelayMs: quantile(delaysB, 0.95), excludedDelayed: delayedB },
    ],
    coverage: { trainSamples: trainPairs.length, holdoutSamples: holdoutPairs.length, excludedNoFuture: all.excludedNoFuture, excludedNoPrior: all.excludedNoPrior },
    lags,
    selectedLagMs,
    holdout: { samples: holdout.samples, hitRate: holdout.hitRate, meanNetPct: holdout.meanNetPct, uncertainty },
    baselines: [baseline('momentum', momentumReturns), baseline('always-long', alwaysLong)],
    sensitivity,
    verdict,
    notes,
  };
}
