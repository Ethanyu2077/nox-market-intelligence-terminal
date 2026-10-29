import type { HistoryStore } from './history-store.ts';
import type { MarketProject } from '../shared/types.ts';
import type {
  AlignmentOutcomeResponse, AlignmentOutcomeRow, AlignmentSnapshotRecord, TimeframeAlignmentState,
} from '../shared/timeframe.ts';
import { alignmentRecordFromPayload } from './alignment-history.ts';

export interface OutcomeSnapshot { time: number; price: number }

const MIN_SAMPLE = 20;
const BASELINE_OFFSET_MS = 30 * 60_000;

function expectedDirection(state: TimeframeAlignmentState): 'up' | 'down' | null {
  if (state === 'aligned-bullish') return 'up';
  if (state === 'aligned-bearish') return 'down';
  return null;
}

function findEntry(snapshots: OutcomeSnapshot[], at: number): OutcomeSnapshot | null {
  // Only snapshots at or after the event may be used as entry (no lookahead).
  let best: OutcomeSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.time >= at) { best = snapshot; break; }
  }
  return best;
}

function findExit(snapshots: OutcomeSnapshot[], eventTime: number, horizonMs: number): OutcomeSnapshot | null {
  const target = eventTime + horizonMs;
  let best: OutcomeSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.time <= target) best = snapshot;
    else break;
  }
  // The exit must cover at least half of the horizon, otherwise it is not an outcome yet.
  if (!best || best.time < eventTime + horizonMs / 2) return null;
  return best;
}

function outcomeFor(record: AlignmentSnapshotRecord, snapshots: OutcomeSnapshot[], horizonMs: number, costBps: number): AlignmentOutcomeRow {
  const decisionTime = Math.max(record.time, record.availableAt ?? record.time);
  const direction = expectedDirection(record.state);
  const base: AlignmentOutcomeRow = { time: record.time, state: record.state, expectedDirection: direction, entryTime: null, entryPrice: null, exitTime: null, exitPrice: null, priceReturnPct: null, grossReturnPct: null, netReturnPct: null, resolved: false, reason: null };
  if (!direction) return { ...base, reason: 'state does not define a directional expectation' };
  const entry = findEntry(snapshots, decisionTime);
  if (!entry) return { ...base, reason: 'no snapshot at/after the claim became available' };
  const exit = findExit(snapshots, decisionTime, horizonMs);
  if (!exit || exit.time <= entry.time) return { ...base, entryTime: entry.time, entryPrice: entry.price, reason: 'horizon not yet reached or no intervening snapshot' };
  const priceReturnPct = (exit.price / entry.price - 1) * 100;
  // Convert the raw price move into the claim's directional P&L before subtracting costs.
  // A short that loses money on a small rise must NOT count as a hit merely because cost makes
  // the number negative: direction and cost are separate operations.
  const grossReturnPct = direction === 'up' ? priceReturnPct : -priceReturnPct;
  return {
    ...base,
    entryTime: entry.time,
    entryPrice: entry.price,
    exitTime: exit.time,
    exitPrice: exit.price,
    priceReturnPct,
    grossReturnPct,
    // Round-trip cost assumption in bps, expressed in percentage points.
    netReturnPct: grossReturnPct - costBps / 100,
    resolved: true,
    reason: null,
  };
}

function directionHit(netReturnPct: number): boolean {
  // Both long and short are scored on direction-adjusted NET return.
  return netReturnPct > 0;
}

/**
 * Descriptive outcome study for ALLOWED directional claims only. The baseline is a placebo
 * snapshot window shifted by -30 minutes, and both use the same horizon and cost model.
 * No hit rate is shown below the minimum resolved sample; that is a refusal, not a 0% rate.
 */
export function summarizeAlignmentOutcomes(
  projectId: string,
  symbol: string | null,
  records: AlignmentSnapshotRecord[],
  snapshots: OutcomeSnapshot[],
  options: { asOf: number; horizonMinutes: number; costBps: number; minSample?: number },
): AlignmentOutcomeResponse {
  const horizonMs = options.horizonMinutes * 60_000;
  const minSample = options.minSample ?? MIN_SAMPLE;
  const asOf = options.asOf;
  const allowed = records
    .filter((record) => record.directionalClaimAllowed)
    .filter((record) => Math.max(record.time, record.availableAt ?? record.time) <= asOf)
    .sort((a, b) => a.time - b.time);
  const usable = snapshots.filter((snapshot) => Number.isFinite(snapshot.time) && Number.isFinite(snapshot.price) && snapshot.price > 0 && snapshot.time <= asOf).sort((a, b) => a.time - b.time);
  const rows = allowed.map((record) => outcomeFor(record, usable, horizonMs, options.costBps));
  const resolved = rows.filter((row) => row.resolved && row.netReturnPct != null && row.expectedDirection);
  const hitRate = resolved.length >= minSample ? resolved.filter((row) => directionHit(row.netReturnPct!)).length / resolved.length * 100 : null;
  const averageNetReturnPct = resolved.length ? resolved.reduce((sum, row) => sum + row.netReturnPct!, 0) / resolved.length : null;
  const baselineRows = allowed.flatMap((record) => {
    const shifted = Math.max(record.time, record.availableAt ?? record.time) - BASELINE_OFFSET_MS;
    const entry = findEntry(usable, shifted);
    if (!entry) return [];
    const exit = findExit(usable, shifted, horizonMs);
    if (!exit || exit.time <= entry.time) return [];
    const direction = expectedDirection(record.state);
    if (!direction) return [];
    const priceReturnPct = (exit.price / entry.price - 1) * 100;
    return [{ direction, netReturnPct: (direction === 'up' ? priceReturnPct : -priceReturnPct) - options.costBps / 100 }];
  });
  const baselineHitRate = baselineRows.length ? baselineRows.filter((row) => directionHit(row.netReturnPct)).length / baselineRows.length * 100 : null;
  const baselineAverageNetReturnPct = baselineRows.length ? baselineRows.reduce((sum, row) => sum + row.netReturnPct, 0) / baselineRows.length : null;
  const status = usable.length < 2 || allowed.length === 0
    ? 'insufficient-history'
    : resolved.length < minSample ? 'insufficient-sample' : 'available';
  return {
    projectId,
    symbol,
    generatedAt: Date.now(),
    horizonMinutes: options.horizonMinutes,
    costBps: options.costBps,
    minSample,
    status,
    allowedEvents: allowed.length,
    resolvedSamples: resolved.length,
    censoredSamples: allowed.length - resolved.length,
    hitRate,
    averageNetReturnPct,
    baselineHitRate,
    baselineAverageNetReturnPct,
    liftPct: hitRate != null && baselineHitRate != null ? hitRate - baselineHitRate : null,
    rows: [...rows].reverse().slice(0, 100),
    methodology: [
      'Only alignment records with directionalClaimAllowed=true are evaluated; refused claims are never scored as wins or losses.',
      'Entry is the first snapshot at/after the claim became available (ingest/decision time), never at the signal timestamp; exit is the last snapshot at/before decision+horizon and must cover at least half the horizon. Otherwise the sample is censored.',
      'Returns are direction-adjusted first (long = price return, short = -price return), then a configurable round-trip cost in bps is subtracted; hits require positive NET directional return. Fees, slippage and latency beyond that are excluded.',
      'Baseline is a placebo snapshot window shifted by -30 minutes using the same horizon/cost rules; it is descriptive, not a significance test.',
      `Fewer than ${minSample} resolved samples produce status=insufficient-sample and no hit rate; this is a refusal, not a 0% rate.`,
      'No out-of-sample or multiple-testing correction is applied here; treat results as descriptive research until a dedicated study exists.',
    ],
  };
}

export async function alignmentOutcomes(
  history: HistoryStore,
  project: MarketProject,
  options: { asOf?: number; horizonMinutes: number; costBps: number },
): Promise<AlignmentOutcomeResponse> {
  const asOf = Math.min(options.asOf ?? Date.now(), Date.now());
  const market = project.markets.find((candidate) => candidate.exchange === 'binance' && candidate.marketType === 'perpetual') ?? null;
  const [alignmentEvents, snapshotEvents] = await Promise.all([
    history.read(project.id, 'alignment', asOf, 5_000),
    history.read(project.id, 'snapshot', asOf, 20_000),
  ]);
  const records = alignmentEvents.flatMap((event) => {
    const record = alignmentRecordFromPayload(event.eventTime, event.payload, event.ingestTime);
    return record ? [record] : [];
  });
  const snapshots = snapshotEvents.flatMap((event) => {
    const payload = event.payload as { exchange?: unknown; marketType?: unknown; symbol?: unknown; price?: unknown; markPrice?: unknown };
    if (payload?.marketType !== 'perpetual') return [];
    if (market && (payload.exchange !== market.exchange || payload.symbol !== market.symbol)) return [];
    const price = typeof payload.price === 'number' ? payload.price : typeof payload.markPrice === 'number' ? payload.markPrice : null;
    return price != null && price > 0 ? [{ time: event.eventTime, price }] : [];
  });
  return summarizeAlignmentOutcomes(project.id, market?.symbol ?? null, records, snapshots, { asOf, horizonMinutes: options.horizonMinutes, costBps: options.costBps });
}
