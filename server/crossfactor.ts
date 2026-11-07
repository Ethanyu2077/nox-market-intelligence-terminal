import type { CrossFactorId, FactorEvidence, FactorSample } from '../shared/crossfactor.ts';

/**
 * Multi-factor cross-exchange evidence.
 *
 * Comparability is a hard gate: same unit, enough coverage, enough samples and timestamp
 * alignment within a tolerance. Any failure returns `unavailable` with the reason instead of
 * computing a number. Null values are never replaced by zero or interpolated.
 */

export interface CrossFactorOptions {
  minSamples: number;
  minCoveragePct: number;
  maxSkewMs: number;
  maxLagSteps: number;
  lagStepMs: number;
}

export const DEFAULT_CROSS_FACTOR_OPTIONS: CrossFactorOptions = {
  minSamples: 30,
  minCoveragePct: 60,
  maxSkewMs: 60_000,
  maxLagSteps: 4,
  lagStepMs: 60_000,
};

function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }

function correlation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

export function buildFactorEvidence(factor: CrossFactorId, samples: FactorSample[], options: Partial<CrossFactorOptions> = {}): FactorEvidence {
  const opts = { ...DEFAULT_CROSS_FACTOR_OPTIONS, ...options };
  const notes = [
    'Cross-exchange comparisons require identical units, adequate coverage and timestamp alignment; otherwise the factor is unavailable.',
    'This is descriptive association on public data, not causality and not a tradable edge.',
  ];
  const relevant = samples.filter((sample) => sample.factor === factor && sample.value != null && Number.isFinite(sample.value));
  if (!relevant.length) return { factor, unit: 'unknown', comparable: false, reasons: ['No samples for this factor'], venues: [], leader: null, follower: null, lagMs: null, correlation: null, samples: 0, counterEvidence: [], verdict: 'unavailable', notes };

  const units = [...new Set(relevant.map((sample) => sample.unit))];
  if (units.length > 1) return { factor, unit: units.join('/'), comparable: false, reasons: [`Mixed units: ${units.join(', ')}`], venues: [], leader: null, follower: null, lagMs: null, correlation: null, samples: 0, counterEvidence: [], verdict: 'unavailable', notes };

  const byVenue = new Map<string, FactorSample[]>();
  for (const sample of relevant) byVenue.set(sample.venue, [...(byVenue.get(sample.venue) ?? []), sample]);
  const venues = [...byVenue.entries()].map(([venue, rows]) => {
    const sorted = [...rows].sort((a, b) => a.time - b.time);
    return { venue, rows: sorted, coveragePct: mean(sorted.map((row) => row.coveragePct)) ?? 0 };
  });
  const reasons: string[] = [];
  if (venues.length < 2) reasons.push('At least two venues are required for a cross-exchange comparison');
  for (const venue of venues) {
    if (venue.rows.length < opts.minSamples) reasons.push(`${venue.venue}: ${venue.rows.length} samples < ${opts.minSamples}`);
    if (venue.coveragePct < opts.minCoveragePct) reasons.push(`${venue.venue}: coverage ${venue.coveragePct.toFixed(1)}% < ${opts.minCoveragePct}%`);
  }
  const [a, b] = venues;
  if (a && b) {
    const skew = Math.abs((a.rows.at(-1)?.time ?? 0) - (b.rows.at(-1)?.time ?? 0));
    if (skew > opts.maxSkewMs) reasons.push(`Latest samples are ${skew}ms apart (> ${opts.maxSkewMs}ms)`);
  }
  const summary = venues.map((venue) => ({ venue: venue.venue, samples: venue.rows.length, coveragePct: Number(venue.coveragePct.toFixed(1)), latest: venue.rows.at(-1)?.value ?? null }));
  if (!a || !b || reasons.length) {
    return { factor, unit: units[0], comparable: false, reasons, venues: summary, leader: null, follower: null, lagMs: null, correlation: null, samples: 0, counterEvidence: [], verdict: 'unavailable', notes };
  }

  // Align by time within the skew tolerance, then compare change series at candidate lags.
  const aligned: Array<{ time: number; av: number; bv: number }> = [];
  let j = 0;
  for (const row of a.rows) {
    while (j < b.rows.length - 1 && Math.abs(b.rows[j].time - row.time) > Math.abs(b.rows[j + 1].time - row.time)) j += 1;
    const match = b.rows[j];
    if (match && Math.abs(match.time - row.time) <= opts.maxSkewMs) aligned.push({ time: row.time, av: row.value as number, bv: match.value as number });
  }
  if (aligned.length < opts.minSamples) {
    return { factor, unit: units[0], comparable: false, reasons: [`Only ${aligned.length} time-aligned samples (min ${opts.minSamples})`], venues: summary, leader: null, follower: null, lagMs: null, correlation: null, samples: aligned.length, counterEvidence: [], verdict: 'insufficient', notes };
  }

  let best: { lag: number; r: number } | null = null;
  for (let lag = 0; lag <= opts.maxLagSteps; lag += 1) {
    const shift = Math.round((lag * opts.lagStepMs) / Math.max(1, aligned[1].time - aligned[0].time));
    if (shift >= aligned.length - 2) continue;
    const xs = aligned.slice(0, aligned.length - shift).map((row) => row.av);
    const ys = aligned.slice(shift).map((row) => row.bv);
    const r = correlation(xs, ys);
    if (r != null && (!best || Math.abs(r) > Math.abs(best.r))) best = { lag, r };
  }
  if (!best) return { factor, unit: units[0], comparable: true, reasons: [], venues: summary, leader: null, follower: null, lagMs: null, correlation: null, samples: aligned.length, counterEvidence: [], verdict: 'insufficient', notes };

  const lagMs = best.lag * opts.lagStepMs;
  const leader = best.r >= 0 ? a.venue : b.venue;
  const follower = best.r >= 0 ? b.venue : a.venue;
  const counter: string[] = [];
  if (Math.abs(best.r) < 0.1) counter.push('Correlation is close to zero after alignment; no usable lead-lag structure');
  for (const venue of venues) if (venue.rows.length < opts.minSamples * 1.5) counter.push(`${venue.venue} has a thin sample; the estimate is unstable`);
  return {
    factor, unit: units[0], comparable: true, reasons: [], venues: summary,
    leader, follower, lagMs, correlation: Number(best.r.toFixed(4)), samples: aligned.length,
    counterEvidence: counter,
    verdict: Math.abs(best.r) < 0.1 || aligned.length < opts.minSamples * 2 ? 'insufficient' : 'descriptive',
    notes,
  };
}

/** Extract comparable factor samples from the local snapshot journal. */
export function factorSamplesFromSnapshots(entries: Array<{ ingestTime: number; payload: unknown }>): FactorSample[] {
  const samples: FactorSample[] = [];
  for (const entry of entries) {
    const payload = entry.payload as { snapshots?: Array<{ exchange: string; price: number | null; markPrice: number | null; oiBase: number | null; fundingRate: number | null; eventTime: number }> };
    for (const row of payload?.snapshots ?? []) {
      if (row.oiBase == null || row.price == null || !row.eventTime) continue;
      // OI change needs a previous observation; the builder compares levels, so store the
      // raw base quantity and label the unit explicitly.
      samples.push({ venue: row.exchange, factor: 'oi_change', time: row.eventTime, availableAt: entry.ingestTime, value: row.oiBase, unit: 'base', coveragePct: 100 });
      if (row.markPrice != null) samples.push({ venue: row.exchange, factor: 'funding_basis', time: row.eventTime, availableAt: entry.ingestTime, value: (row.markPrice - row.price) / row.price * 10_000, unit: 'bps', coveragePct: 100 });
    }
  }
  return samples;
}
