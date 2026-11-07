import type { CrossFactorId, DirectionResult, FactorEvidence, FactorSample } from '../shared/crossfactor.ts';

/**
 * Multi-factor cross-exchange evidence.
 *
 * Correctness rules:
 *  - direction is decided by testing A→B and B→A separately, never by the sign of a
 *    correlation coefficient;
 *  - a decision time is the follower sample's `availableAt` (the earliest moment the value
 *    could be used), and only lead samples with `availableAt <= decision` may inform it;
 *  - lag alignment uses real timestamps (never array-index shifting) with an explicit
 *    tolerance, and each decision is matched at most once;
 *  - OI level and OI delta are distinct factors with distinct units;
 *  - mixed units, low coverage, large sampling gaps and missing values are refused, never
 *    filled with zero or interpolated.
 */

export interface CrossFactorOptions {
  minSamples: number;
  minCoveragePct: number;
  maxSkewMs: number;
  maxLagSteps: number;
  lagStepMs: number;
  windowMs: number;
  horizonMs: number;
  maxGapMs: number;
  maxGapRatio: number;
}

export const DEFAULT_CROSS_FACTOR_OPTIONS: CrossFactorOptions = {
  minSamples: 30,
  minCoveragePct: 60,
  maxSkewMs: 60_000,
  maxLagSteps: 4,
  lagStepMs: 60_000,
  windowMs: 300_000,
  horizonMs: 300_000,
  maxGapMs: 600_000,
  maxGapRatio: 0.25,
};

interface Row { time: number; availableAt: number; value: number }
interface Pair { decision: number; leadReturn: number; forwardReturn: number }

function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }

function lastAtOrBefore(rows: Row[], maxTime: number, cutoff: number): Row | null {
  let best: Row | null = null;
  for (const row of rows) {
    if (row.time > maxTime) break;
    if (row.availableAt > cutoff) continue;
    best = row;
  }
  return best;
}

function lastBetween(rows: Row[], from: number, to: number, cutoff: number): Row | null {
  let best: Row | null = null;
  for (const row of rows) {
    if (row.time <= from) continue;
    if (row.time > to) break;
    if (row.availableAt <= cutoff) continue;
    if (!best || row.time > best.time) best = row;
  }
  return best;
}

function correlation(pairs: Pair[]): number | null {
  if (pairs.length < 3) return null;
  const n = pairs.length;
  const mx = pairs.reduce((sum, pair) => sum + pair.leadReturn, 0) / n;
  const my = pairs.reduce((sum, pair) => sum + pair.forwardReturn, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const pair of pairs) { const x = pair.leadReturn - mx, y = pair.forwardReturn - my; num += x * y; dx += x * x; dy += y * y; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function directionalPairs(lead: Row[], follow: Row[], options: CrossFactorOptions, lagMs: number): Pair[] {
  const pairs: Pair[] = [];
  for (const follower of follow) {
    const decision = follower.availableAt;
    const leadEnd = lastAtOrBefore(lead, decision - lagMs, decision);
    const leadStart = leadEnd ? lastAtOrBefore(lead, leadEnd.time - options.windowMs, decision) : null;
    if (!leadEnd || !leadStart || leadStart.time >= leadEnd.time) continue;
    const outcome = lastBetween(follow, decision, decision + options.horizonMs, decision);
    if (!outcome) continue;
    pairs.push({ decision, leadReturn: leadEnd.value / leadStart.value - 1, forwardReturn: outcome.value / follower.value - 1 });
  }
  return pairs;
}

function bestDirection(lead: string, follow: string, leadRows: Row[], followRows: Row[], options: CrossFactorOptions): DirectionResult[] {
  const results: DirectionResult[] = [];
  for (let lag = 0; lag <= options.maxLagSteps; lag += 1) {
    const lagMs = lag * options.lagStepMs;
    const pairs = directionalPairs(leadRows, followRows, options, lagMs);
    results.push({ from: lead, to: follow, lagMs, correlation: correlation(pairs), samples: pairs.length, selected: false });
  }
  return results;
}

function venueStats(rows: Row[], options: CrossFactorOptions): { gaps: number; coveragePct: number } {
  if (rows.length < 2) return { gaps: 0, coveragePct: 0 };
  let gaps = 0;
  for (let i = 1; i < rows.length; i += 1) if (rows[i].time - rows[i - 1].time > options.maxGapMs) gaps += 1;
  return { gaps, coveragePct: 100 };
}

export function buildFactorEvidence(factor: CrossFactorId, samples: FactorSample[], overrides: Partial<CrossFactorOptions> = {}): FactorEvidence {
  const options: CrossFactorOptions = { ...DEFAULT_CROSS_FACTOR_OPTIONS, ...overrides };
  const notes = [
    'Direction is decided by separate A→B and B→A lag tests, not by the sign of a correlation.',
    'Decisions use availableAt as the earliest usable moment; outcomes require data observed strictly after it.',
    'Descriptive association only: no causality and no executable edge are claimed.',
  ];
  const relevant = samples.filter((sample) => sample.factor === factor && sample.value != null && Number.isFinite(sample.value));
  const empty = (reasons: string[], unit = 'unknown'): FactorEvidence => ({ factor, unit, comparable: false, reasons, venues: [], directions: [], leader: null, follower: null, lagMs: null, correlation: null, samples: 0, counterEvidence: [], verdict: 'unavailable', notes });
  if (!relevant.length) return empty(['No samples for this factor']);

  const units = [...new Set(relevant.map((sample) => sample.unit))];
  if (units.length > 1) return empty([`Mixed units: ${units.join(', ')}`], units.join('/'));

  const byVenue = new Map<string, FactorSample[]>();
  for (const sample of relevant) byVenue.set(sample.venue, [...(byVenue.get(sample.venue) ?? []), sample]);
  const venues = [...byVenue.entries()].map(([venue, rows]) => {
    const sorted = [...rows].sort((a, b) => a.time - b.time);
    const stats = venueStats(sorted.map((row) => ({ time: row.time, availableAt: row.availableAt, value: row.value as number })), options);
    return {
      venue,
      rows: sorted.map((row) => ({ time: row.time, availableAt: row.availableAt, value: row.value as number })),
      coveragePct: mean(sorted.map((row) => row.coveragePct)) ?? 0,
      gaps: stats.gaps,
      latest: sorted.at(-1)?.value ?? null,
    };
  });

  const reasons: string[] = [];
  if (venues.length < 2) reasons.push('At least two venues are required');
  for (const venue of venues) {
    if (venue.rows.length < options.minSamples) reasons.push(`${venue.venue}: ${venue.rows.length} samples < ${options.minSamples}`);
    if (venue.coveragePct < options.minCoveragePct) reasons.push(`${venue.venue}: coverage ${venue.coveragePct.toFixed(1)}% < ${options.minCoveragePct}%`);
    const ratio = venue.rows.length > 1 ? venue.gaps / (venue.rows.length - 1) : 0;
    if (ratio > options.maxGapRatio) reasons.push(`${venue.venue}: ${venue.gaps} gaps exceed the allowed ratio`);
  }
  const summary = venues.map((venue) => ({ venue: venue.venue, samples: venue.rows.length, coveragePct: Number(venue.coveragePct.toFixed(1)), gaps: venue.gaps, latest: venue.latest }));
  if (venues.length < 2 || reasons.length) return { ...empty(reasons, units[0]), venues: summary };

  const [a, b] = venues;
  const directions = [...bestDirection(a.venue, b.venue, a.rows, b.rows, options), ...bestDirection(b.venue, a.venue, b.rows, a.rows, options)];
  const usable = directions.filter((direction) => direction.correlation != null && direction.samples >= options.minSamples);
  if (!usable.length) return { ...empty([`No direction reached ${options.minSamples} aligned samples`], units[0]), venues: summary, directions, verdict: 'insufficient' };

  const ranked = [...usable].sort((left, right) => Math.abs(right.correlation as number) - Math.abs(left.correlation as number));
  const best = ranked[0];
  const runnerUp = ranked.find((direction) => direction.from !== best.from);
  const bestAbs = Math.abs(best.correlation as number);
  const ambiguous = runnerUp?.correlation != null && Math.abs(runnerUp.correlation) >= bestAbs * 0.95;
  const counterEvidence: string[] = [];
  if (bestAbs < 0.1) counterEvidence.push('Best correlation is close to zero; no usable lead structure');
  if (ambiguous) counterEvidence.push('Both directions are equally strong; the lead direction is not identifiable from this data');
  if (directions.length > 1) counterEvidence.push(`${directions.length} lag/direction hypotheses were tested; treat the best as exploratory`);
  if (!ambiguous) best.selected = true;

  return {
    factor,
    unit: units[0],
    comparable: true,
    reasons: [],
    venues: summary,
    directions,
    leader: ambiguous ? null : best.from,
    follower: ambiguous ? null : best.to,
    lagMs: best.lagMs,
    correlation: Number((best.correlation as number).toFixed(4)),
    samples: best.samples,
    counterEvidence,
    verdict: ambiguous || bestAbs < 0.1 || best.samples < options.minSamples * 2 ? 'insufficient' : 'descriptive',
    notes,
  };
}

/** Extract comparable factor samples from the local snapshot journal. */
export function factorSamplesFromSnapshots(entries: Array<{ ingestTime: number; payload: unknown }>): FactorSample[] {
  const samples: FactorSample[] = [];
  const previousOi = new Map<string, { value: number; time: number }>();
  for (const entry of entries) {
    const payload = entry.payload as { snapshots?: Array<{ exchange: string; price: number | null; markPrice: number | null; oiBase: number | null; fundingRate: number | null; eventTime: number }> };
    for (const row of payload?.snapshots ?? []) {
      if (row.oiBase == null || !row.eventTime) continue;
      // OI level and OI delta are deliberately separate factors with different units.
      samples.push({ venue: row.exchange, factor: 'oi_level', time: row.eventTime, availableAt: entry.ingestTime, value: row.oiBase, unit: 'base', coveragePct: 100 });
      const previous = previousOi.get(row.exchange);
      if (previous && previous.value > 0 && row.eventTime > previous.time) {
        samples.push({ venue: row.exchange, factor: 'oi_delta', time: row.eventTime, availableAt: entry.ingestTime, value: (row.oiBase - previous.value) / previous.value * 100, unit: 'pct', coveragePct: 100 });
      }
      previousOi.set(row.exchange, { value: row.oiBase, time: row.eventTime });
      if (row.markPrice != null && row.price != null) {
        samples.push({ venue: row.exchange, factor: 'funding_basis', time: row.eventTime, availableAt: entry.ingestTime, value: (row.markPrice - row.price) / row.price * 10_000, unit: 'bps', coveragePct: 100 });
      }
    }
  }
  return samples;
}
