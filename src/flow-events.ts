import type { WatchRow } from '../shared/watch-overview';

const money = (value: number | null) => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
const pct = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

export type EventRow = { projectId: string; time: number; kind: string; detail: string; tone: 'up' | 'down' | 'warn' };

/** Signals are descriptive statistics over the returned window, not trade recommendations. */
export function deriveFlowEvents(rows: WatchRow[], end: number): EventRow[] {
  const events: EventRow[] = [];
  for (const row of rows) {
    const flow = row.flow;
    const buckets = flow?.buckets ?? [];
    const closed = buckets.filter((bucket) => bucket.delta != null);
    const last = closed.at(-1);
    const prior = closed.slice(-13, -1).map((bucket) => Math.abs(bucket.delta ?? 0)).sort((a, b) => a - b);
    const median = prior.length ? prior[Math.floor(prior.length / 2)] : 0;
    if (last?.delta != null && median > 0 && Math.abs(last.delta) / median >= 3) {
      events.push({ projectId: row.projectId, time: last.time, kind: 'FLOW SPIKE', detail: `${money(last.delta)} vs ${money(median)} median`, tone: last.delta >= 0 ? 'up' : 'down' });
    }
    const firstCvd = closed.find((bucket) => bucket.cvd != null)?.cvd;
    const lastCvd = closed.at(-1)?.cvd;
    const price = row.candles.length > 13 ? (row.candles.at(-1)!.close / row.candles.at(-13)!.close - 1) * 100 : null;
    if (price != null && firstCvd != null && lastCvd != null) {
      const cvdDelta = lastCvd - firstCvd;
      if (price >= 0.5 && cvdDelta < 0) events.push({ projectId: row.projectId, time: end, kind: 'CVD DIVERGENCE', detail: `price ${pct(price)} but CVD ${money(cvdDelta)}`, tone: 'warn' });
      if (price <= -0.5 && cvdDelta > 0) events.push({ projectId: row.projectId, time: end, kind: 'CVD DIVERGENCE', detail: `price ${pct(price)} but CVD +${money(cvdDelta)}`, tone: 'warn' });
    }
    const oi = row.oiSeries?.filter((point) => point.time >= end - 3_600_000) ?? [];
    if (oi.length > 1 && oi[0].oiUsd > 0) {
      const change = (oi.at(-1)!.oiUsd / oi[0].oiUsd - 1) * 100;
      if (Math.abs(change) >= 1.5) events.push({ projectId: row.projectId, time: end, kind: 'OI CHANGE', detail: `${pct(change)} in 1h`, tone: change >= 0 ? 'up' : 'down' });
    }
    if (row.funding) {
      const annual = row.funding.rate * 100 * 8 / row.funding.hours;
      if (Math.abs(annual) >= 50) events.push({ projectId: row.projectId, time: end, kind: 'FUNDING', detail: `${annual.toFixed(1)}% annualised`, tone: annual >= 0 ? 'up' : 'down' });
    }
  }
  return events.sort((a, b) => b.time - a.time).slice(0, 20);
}

