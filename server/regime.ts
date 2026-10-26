import type { VenueMarketSnapshot } from '../shared/types.ts';
import type { OrderFlowResponse } from '../shared/orderflow.ts';
import type { HistoryEvent } from './history-store.ts';

export interface RegimeSignal {
  id: string; projectId: string; timestamp: number; classification: 'statistical-inference';
  label: string; heuristicConfidence: number | null; evidence: string[]; counterevidence: string[]; missing: string[];
  metrics: { priceChangePct: number | null; oiChangePct: number | null; deltaUsd: number | null; spotDeltaUsd: number | null; fundingRate: number | null };
  venue: string | null; referencePrice: number | null; referencePriceTime: number | null; version: 'nox.regime.v1';
}
const pct = (a: number | null, b: number | null) => a != null && b != null && b > 0 ? (a / b - 1) * 100 : null;
/** Five-minute same-venue comparison, never 24h price vs intraminute orderflow. */
export function evaluateRegime(projectId: string, history: HistoryEvent[], flow: OrderFlowResponse, now: number): RegimeSignal {
  const rows = history.filter(e => e.ingestTime <= now && e.eventTime <= now && e.kind === 'snapshot').sort((a,b) => a.ingestTime - b.ingestTime);
  const windowEnd = Math.floor(now / 300_000) * 300_000;
  const latest = [...rows].reverse().find(e => (e.payload as VenueMarketSnapshot).marketType === 'perpetual' && e.eventTime <= windowEnd && e.eventTime >= windowEnd - 90_000);
  const current = latest?.payload as VenueMarketSnapshot | undefined;
  const base = latest && [...rows].reverse().find(e => e.marketKey === latest.marketKey && e.eventTime <= latest.eventTime - 300_000 && e.eventTime >= latest.eventTime - 390_000);
  const prior = base?.payload as VenueMarketSnapshot | undefined;
  const fresh = !!latest && windowEnd - latest.eventTime <= 90_000 && now - latest.ingestTime < 390_000;
  const price = fresh && current && prior ? pct(current.price, prior.price) : null;
  const oi = fresh && current && prior ? pct(current.oiBase, prior.oiBase) : null;
  const venueFlow = flow.venues.find(v => v.key === latest?.marketKey);
  const bucket = venueFlow?.buckets.find(b => b.time === Math.floor(now / 300_000) * 300_000 - 300_000);
  // Only contiguous, fully closed buckets qualify. Missing means null, never zero.
  const delta = bucket?.complete ? bucket.delta : null;
  const spot = flow.aggregates.spot.buckets.find(b => b.time === bucket?.time);
  const spotDelta = spot?.complete ? spot.delta : null;
  const missing: string[] = [];
  if (!fresh) missing.push('Perpetual snapshot within 90s before the closed 5m boundary');
  if (!base) missing.push('Same-venue 5-minute baseline (maximum 90s timing tolerance)');
  if (price == null) missing.push('Comparable price'); if (oi == null) missing.push('Comparable token-quantity OI');
  if (delta == null) missing.push('Complete aligned 5-minute aggressor flow');
  if (spotDelta == null) missing.push('Complete selected-spot flow');
  missing.push('Historical depth/basis and complete liquidation coverage are not available to this rule version');
  const evidence: string[] = [`Closed analytical window ends ${new Date(windowEnd).toISOString()}; snapshots have up to 90s boundary tolerance.`], counterevidence = ['OI does not identify the owners or opening/closing side of individual positions.', 'Heuristic score is not a calibrated probability; no execution recommendation.', 'Repeated evaluations overlap; samples are not independent.'];
  if (price != null) evidence.push(`Same-venue price change ${price.toFixed(3)}%`);
  if (oi != null) evidence.push(`Token OI change ${oi.toFixed(3)}% (not USD revaluation)`);
  if (delta != null) evidence.push(`Closed 5m aggressor volume delta ${delta.toFixed(2)} USDT`);
  let label = 'Insufficient evidence', confidence: number | null = null;
  if (price != null && oi != null && delta != null) {
    label = 'Mixed / neutral'; confidence = 0.35;
    if (oi > 0.25 && price > 0.1 && delta > 0) { label = 'Potential long build-up'; confidence = 0.65; }
    else if (oi > 0.25 && price < -0.1 && delta < 0) { label = 'Potential short build-up'; confidence = 0.65; }
    else if (oi < -0.25 && price < -0.1 && delta < 0) { label = 'Potential deleveraging'; confidence = 0.6; counterevidence.push('Liquidation cascade is NOT confirmed by this classification.'); }
    else if (oi < -0.25 && price > 0.1 && delta > 0) { label = 'Potential short covering'; confidence = 0.6; }
    else if (Math.abs(price) < 0.1 && delta !== 0) { label = 'Potential absorption'; confidence = 0.45; }
    if (spotDelta != null && Math.sign(spotDelta) !== Math.sign(delta)) { counterevidence.push('Spot and perpetual aggressive flow disagree.'); confidence = Math.max(0.2, confidence - 0.15); }
  }
  const anchor = latest && [...rows].reverse().find(e => e.marketKey === latest.marketKey && now - e.eventTime <= 90_000);
  return { id: `${projectId}:regime:${now}`, projectId, timestamp: now, classification: 'statistical-inference', label, heuristicConfidence: confidence, evidence, counterevidence, missing, metrics: { priceChangePct: price, oiChangePct: oi, deltaUsd: delta, spotDeltaUsd: spotDelta, fundingRate: fresh ? current?.fundingRate ?? null : null }, venue: latest?.marketKey ?? null, referencePrice: anchor ? (anchor.payload as VenueMarketSnapshot).price : null, referencePriceTime: anchor?.eventTime ?? null, version: 'nox.regime.v1' };
}

export function signalLab(signals: HistoryEvent[], snapshots: HistoryEvent[], horizonMinutes: number, costBps: number, asOf = Date.now()) {
  const horizon = horizonMinutes * 60_000;
  const rows = signals.filter(e => e.source !== 'nox.regime.v2' && e.ingestTime <= asOf && e.eventTime <= asOf).map(e => {
    const signal = e.payload as RegimeSignal;
    const start = signal.timestamp, end = start + horizon;
    const path = snapshots.filter(s => s.marketKey === signal.venue && s.eventTime > start && s.eventTime <= end && s.ingestTime <= asOf && s.eventTime <= asOf).sort((a,b) => a.eventTime - b.eventTime);
    const final = path.at(-1);
    const values = path.map(s => (s.payload as VenueMarketSnapshot).price).filter((p): p is number => p != null && p > 0);
    const largestGap = Math.max(0, ...path.map((s,i) => s.eventTime - (i ? path[i-1].eventTime : start)));
    const complete = end <= asOf && !!final && end - final.eventTime <= 90_000 && largestGap <= 390_000 && !!signal.referencePrice;
    const returns = complete && signal.referencePrice ? values.map(p => (p / signal.referencePrice! - 1) * 100) : [];
    const raw = returns.at(-1) ?? null;
    const direction = /short build/.test(signal.label) ? -1 : /long build|short covering/.test(signal.label) ? 1 : null;
    const directed = direction == null ? [] : returns.map(r => r * direction);
    return { id: signal.id, timestamp: start, label: signal.label, horizonMinutes, complete, priceReturnPct: raw, researchDirectionalReturnAfterCostsPct: raw != null && direction != null ? raw * direction - costBps / 100 : null, sampledMfePct: directed.length ? Math.max(0,...directed) : null, sampledMaePct: directed.length ? Math.min(0,...directed) : null, samples: values.length, cohort: start < asOf - 7 * 86_400_000 ? 'development' : 'out-of-sample-candidate', missing: complete ? [] : ['Horizon not matured or snapshot path has gaps'] };
  });
  return { rows, horizonMinutes, roundTripCostBps: costBps, methodology: ['Immutable recorded signals; no retrospective relabeling.', 'Only records ingested by asOf are visible.', 'MFE/MAE use sampled snapshot prices, not true tick extremes.', 'Temporal holdout candidate is not validated out-of-sample performance.', 'Directional returns are research scenarios, not trades. No inferred direction for neutral/absorption/deleveraging.'], coverage: { recorded: rows.length, evaluated: rows.filter(r => r.complete).length } };
}
