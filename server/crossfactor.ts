import type { CrossFactorId, DirectionResult, FactorEvidence, FactorPair, FactorSample } from '../shared/crossfactor.ts';

/**
 * Multi-factor cross-exchange evidence.
 *
 * Units are not interchangeable: relative factors (levels) use a guarded relative change,
 * while factors that are already changes (OI delta %, basis bps, depth change %) use a
 * difference. Zero/negative bases, cross-zero levels and extreme outliers are excluded
 * rather than producing infinite or meaningless changes. Direction is decided by separate
 * A→B / B→A tests at every lag; the sign of a correlation never selects the leader.
 */

export interface CrossFactorOptions {
  minSamples: number;
  minCoveragePct: number;
  maxLagSteps: number;
  lagStepMs: number;
  windowMs: number;
  horizonMs: number;
  maxGapMs: number;
  maxGapRatio: number;
  outlierMad: number;
}

export const DEFAULT_CROSS_FACTOR_OPTIONS: CrossFactorOptions = {
  minSamples: 30,
  minCoveragePct: 60,
  maxLagSteps: 4,
  lagStepMs: 60_000,
  windowMs: 300_000,
  horizonMs: 300_000,
  maxGapMs: 600_000,
  maxGapRatio: 0.25,
  outlierMad: 8,
};

interface Row { time: number; availableAt: number; value: number }
interface Pair { decision: number; leadChange: number; forwardChange: number }

/** Factors already expressed as a change use a difference; levels use a relative change. */
export function transformFor(factor: CrossFactorId): 'relative' | 'difference' {
  return factor === 'oi_level' ? 'relative' : 'difference';
}

export function changeOf(previous: number, current: number, transform: 'relative' | 'difference'): number | null {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  if (transform === 'difference') return current - previous;
  // A zero/negative base or a cross-zero move has no meaningful relative change.
  if (previous <= 0 || current <= 0) return null;
  return current / previous - 1;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trimOutliers(pairs: Pair[], madLimit: number): Pair[] {
  if (pairs.length < 8) return pairs;
  const changes = pairs.map((pair) => pair.leadChange);
  const center = median(changes);
  const deviation = median(changes.map((value) => Math.abs(value - center)));
  if (deviation === 0) return pairs;
  return pairs.filter((pair) => Math.abs(pair.leadChange - center) <= madLimit * deviation);
}

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
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((sum, pair) => sum + pair.leadChange, 0) / n;
  const my = pairs.reduce((sum, pair) => sum + pair.forwardChange, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const pair of pairs) { const x = pair.leadChange - mx, y = pair.forwardChange - my; num += x * y; dx += x * x; dy += y * y; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function directionalPairs(lead: Row[], follow: Row[], options: CrossFactorOptions, lagMs: number, transform: 'relative' | 'difference'): Pair[] {
  const pairs: Pair[] = [];
  for (const follower of follow) {
    const decision = follower.availableAt;
    const leadEnd = lastAtOrBefore(lead, decision - lagMs, decision);
    const leadStart = leadEnd ? lastAtOrBefore(lead, leadEnd.time - options.windowMs, decision) : null;
    if (!leadEnd || !leadStart || leadStart.time >= leadEnd.time) continue;
    const outcome = lastBetween(follow, decision, decision + options.horizonMs, decision);
    if (!outcome) continue;
    const leadChange = changeOf(leadStart.value, leadEnd.value, transform);
    const forwardChange = changeOf(follower.value, outcome.value, transform);
    if (leadChange == null || forwardChange == null) continue;
    pairs.push({ decision, leadChange, forwardChange });
  }
  return trimOutliers(pairs, options.outlierMad);
}

function testDirection(lead: string, follow: string, leadRows: Row[], followRows: Row[], options: CrossFactorOptions, transform: 'relative' | 'difference'): DirectionResult[] {
  const results: DirectionResult[] = [];
  for (let lag = 0; lag <= options.maxLagSteps; lag += 1) {
    const lagMs = lag * options.lagStepMs;
    const pairs = directionalPairs(leadRows, followRows, options, lagMs, transform);
    results.push({ from: lead, to: follow, lagMs, correlation: correlation(pairs), samples: pairs.length, selected: false });
  }
  return results;
}

export function buildFactorEvidence(factor: CrossFactorId, samples: FactorSample[], overrides: Partial<CrossFactorOptions> = {}): FactorEvidence {
  const options: CrossFactorOptions = { ...DEFAULT_CROSS_FACTOR_OPTIONS, ...overrides };
  const transform = transformFor(factor);
  const notes = [
    'Direction is decided by separate A→B and B→A lag tests, not by the sign of a correlation.',
    `Factor transform: ${transform === 'relative' ? 'guarded relative change (levels)' : 'difference of changes (already-differenced factors)'}.`,
    'Zero/negative bases, cross-zero levels and MAD outliers are excluded; nothing is zero-filled.',
    'Descriptive association only: no causality and no executable edge are claimed.',
  ];
  const relevant = samples.filter((sample) => sample.factor === factor && sample.value != null && Number.isFinite(sample.value));
  const base = { factor, notes, transform };
  const empty = (reasons: string[], unit = 'unknown'): FactorEvidence => ({
    ...base, unit, comparable: false, reasons, venues: [], directions: [], pairs: [],
    hypothesesTested: 0, bonferroniAlpha: 0.05, leader: null, follower: null, lagMs: null, correlation: null,
    samples: 0, counterEvidence: [], verdict: 'unavailable',
  });
  if (!relevant.length) return empty(['No samples for this factor']);

  const units = [...new Set(relevant.map((sample) => sample.unit))];
  if (units.length > 1) return empty([`Mixed units: ${units.join(', ')}`], units.join('/'));

  const byVenue = new Map<string, FactorSample[]>();
  for (const sample of relevant) byVenue.set(sample.venue, [...(byVenue.get(sample.venue) ?? []), sample]);
  const venues = [...byVenue.entries()].map(([venue, rows]) => {
    const sorted = [...rows].sort((a, b) => a.time - b.time);
    let gaps = 0;
    for (let index = 1; index < sorted.length; index += 1) if (sorted[index].time - sorted[index - 1].time > options.maxGapMs) gaps += 1;
    return {
      venue,
      rows: sorted.map((row) => ({ time: row.time, availableAt: row.availableAt, value: row.value as number })),
      coveragePct: sorted.reduce((sum, row) => sum + row.coveragePct, 0) / sorted.length,
      gaps,
      latest: sorted.at(-1)?.value ?? null,
    };
  });
  const summary = venues.map((venue) => ({ venue: venue.venue, samples: venue.rows.length, coveragePct: Number(venue.coveragePct.toFixed(1)), gaps: venue.gaps, latest: venue.latest }));

  const reasons: string[] = [];
  if (venues.length < 2) reasons.push('At least two venues are required');
  for (const venue of venues) {
    if (venue.rows.length < options.minSamples) reasons.push(`${venue.venue}: ${venue.rows.length} samples < ${options.minSamples}`);
    if (venue.coveragePct < options.minCoveragePct) reasons.push(`${venue.venue}: coverage ${venue.coveragePct.toFixed(1)}% < ${options.minCoveragePct}%`);
    const ratio = venue.rows.length > 1 ? venue.gaps / (venue.rows.length - 1) : 0;
    if (ratio > options.maxGapRatio) reasons.push(`${venue.venue}: ${venue.gaps} gaps exceed the allowed ratio`);
  }
  if (venues.length < 2 || reasons.length) return { ...empty(reasons, units[0]), venues: summary };

  // Every valid venue combination, both directions. No "first two venues only".
  const pairs: FactorPair[] = [];
  const hypothesesPerPair = 2 * (options.maxLagSteps + 1);
  for (let i = 0; i < venues.length; i += 1) {
    for (let j = i + 1; j < venues.length; j += 1) {
      const a = venues[i], b = venues[j];
      const directions = [...testDirection(a.venue, b.venue, a.rows, b.rows, options, transform), ...testDirection(b.venue, a.venue, b.rows, a.rows, options, transform)];
      const usable = directions.filter((direction) => direction.correlation != null && direction.samples >= options.minSamples);
      if (!usable.length) {
        pairs.push({ venues: [a.venue, b.venue], directions, leader: null, follower: null, lagMs: null, correlation: null, samples: 0, verdict: 'insufficient' });
        continue;
      }
      const ranked = [...usable].sort((left, right) => Math.abs(right.correlation as number) - Math.abs(left.correlation as number));
      const best = ranked[0];
      const runnerUp = ranked.find((direction) => direction.from !== best.from);
      const ambiguous = runnerUp?.correlation != null && Math.abs(runnerUp.correlation) >= Math.abs(best.correlation as number) * 0.95;
      if (!ambiguous) best.selected = true;
      pairs.push({
        venues: [a.venue, b.venue], directions,
        leader: ambiguous ? null : best.from, follower: ambiguous ? null : best.to,
        lagMs: best.lagMs, correlation: Number((best.correlation as number).toFixed(4)), samples: best.samples,
        verdict: ambiguous || Math.abs(best.correlation as number) < 0.1 || best.samples < options.minSamples * 2 ? 'insufficient' : 'descriptive',
      });
    }
  }

  const strong = pairs.filter((pair) => pair.leader != null).sort((left, right) => Math.abs(right.correlation ?? 0) - Math.abs(left.correlation ?? 0));
  const top = strong[0] ?? null;
  const hypothesesTested = pairs.length * hypothesesPerPair;
  const counterEvidence: string[] = [];
  if (!top) counterEvidence.push('No venue pair produced a directional estimate with enough samples');
  else {
    if (Math.abs(top.correlation as number) < 0.1) counterEvidence.push('Best correlation is close to zero; no usable lead structure');
    const reverse = top.directions.find((direction) => direction.from === top.follower && direction.lagMs === 0);
    if (reverse?.correlation != null && Math.abs(reverse.correlation) > Math.abs(top.correlation as number) * 0.8) counterEvidence.push('The reverse direction is nearly as strong; direction is not robust');
  }
  if (hypothesesTested > 1) counterEvidence.push(`${hypothesesTested} pair/direction/lag hypotheses were tested; treat the best as exploratory`);
  const verdict: FactorEvidence['verdict'] = !top ? 'insufficient' : top.verdict;

  return {
    ...base,
    unit: units[0],
    comparable: true,
    reasons: [],
    venues: summary,
    directions: top?.directions ?? [],
    pairs,
    hypothesesTested,
    bonferroniAlpha: 0.05 / Math.max(1, hypothesesTested),
    leader: top?.leader ?? null,
    follower: top?.follower ?? null,
    lagMs: top?.lagMs ?? null,
    correlation: top?.correlation ?? null,
    samples: top?.samples ?? 0,
    counterEvidence,
    verdict,
  };
}

/** Extract comparable factor samples from the local snapshot journal. */
export function factorSamplesFromSnapshots(entries: Array<{ ingestTime: number; payload: unknown }>): FactorSample[] {
  const byVenue = new Map<string, Array<{ time: number; availableAt: number; oiBase: number; price: number | null; markPrice: number | null }>>();
  for (const entry of entries) {
    const payload = entry.payload as { snapshots?: Array<{ exchange: string; price: number | null; markPrice: number | null; oiBase: number | null; eventTime: number }> };
    for (const row of payload?.snapshots ?? []) {
      if (row.oiBase == null || !row.eventTime) continue;
      const rows = byVenue.get(row.exchange) ?? [];
      rows.push({ time: row.eventTime, availableAt: entry.ingestTime, oiBase: row.oiBase, price: row.price, markPrice: row.markPrice });
      byVenue.set(row.exchange, rows);
    }
  }

  const samples: FactorSample[] = [];
  for (const [venue, rows] of byVenue) {
    // Sort by event time per exchange before computing deltas; never compute across a gap.
    const sorted = [...rows].sort((left, right) => left.time - right.time);
    for (let index = 0; index < sorted.length; index += 1) {
      const row = sorted[index];
      samples.push({ venue, factor: 'oi_level', time: row.time, availableAt: row.availableAt, value: row.oiBase, unit: 'base', coveragePct: 100 });
      const previous = sorted[index - 1];
      if (previous && row.time > previous.time && row.time - previous.time <= 600_000 && previous.oiBase > 0) {
        samples.push({ venue, factor: 'oi_delta', time: row.time, availableAt: row.availableAt, value: (row.oiBase - previous.oiBase) / previous.oiBase * 100, unit: 'pct', coveragePct: 100 });
      }
      if (row.markPrice != null && row.price != null && row.price > 0) {
        samples.push({ venue, factor: 'funding_basis', time: row.time, availableAt: row.availableAt, value: (row.markPrice - row.price) / row.price * 10_000, unit: 'bps', coveragePct: 100 });
      }
    }
  }
  return samples;
}
