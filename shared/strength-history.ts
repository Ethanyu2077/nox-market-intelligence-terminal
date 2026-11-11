import type { MarketProject } from './types.ts';

export const STRENGTH_GAP_MS = 5_000;
export const STRENGTH_WINDOW_MS = 60_000;
export type StrengthPoint = { t: number; p: number };
export type StrengthReturnPoint = { t: number; value: number };
export type LiveStrengthReturn = { points: StrengthReturnPoint[]; latest: number | null; stale: boolean };
export type WatchProject = Pick<MarketProject, 'id' | 'markets' | 'primaryMarketId'>;
interface History {
  marketKey: string;
  points: StrengthPoint[];
  livePriceAt: number | null;
}

export function strengthMarketKey(project: WatchProject) {
  const market = project.markets.find(item => item.id === project.primaryMarketId) ?? project.markets[0];
  return market ? `${market.exchange}:${market.marketType}:${market.symbol}` : null;
}

function prune(points: StrengthPoint[], cutoff: number) {
  let expired = 0;
  while (expired < points.length && points[expired].t < cutoff) expired++;
  if (expired) points.splice(0, expired);
}

function quotePoint(t: unknown, p: unknown, now: number): StrengthPoint | null {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t < now - STRENGTH_WINDOW_MS || t > now + STRENGTH_GAP_MS) return null;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return null;
  return { t, p };
}

/** Keep observed chart paths through brief outages. Only fresh returns participate in live rankings. */
export function liveStrengthReturns(
  series: ReadonlyMap<string, readonly StrengthPoint[]>,
  now: number,
  staleIds: ReadonlySet<string>,
  connected: boolean,
): Map<string, LiveStrengthReturn> {
  const returns = new Map<string, LiveStrengthReturn>();
  const start = now - STRENGTH_WINDOW_MS;
  for (const [id, samples] of series) {
    const window = samples.filter(point => point.t >= start && point.t <= now && Number.isFinite(point.p) && point.p > 0);
    if (!window.length) continue;
    const base = window[0].p;
    const points = window.map(({ t, p }) => ({ t, value: (p - base) / base * 100 }));
    const last = points[points.length - 1];
    const stale = !connected || staleIds.has(id) || now - last.t > STRENGTH_GAP_MS;
    returns.set(id, { points, latest: stale ? null : last.value, stale });
  }
  return returns;
}

/** Read an observed value at or before the cursor. A missing bucket or an expired quote has no value. */
export function strengthValueAt(
  points: readonly { t: number; value: number | null }[],
  time: number,
  maxGapMs = STRENGTH_GAP_MS,
): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point.t <= time) return time - point.t <= maxGapMs ? point.value : null;
  }
  return null;
}

export class StrengthHistory {
  private histories = new Map<string, History>();

  watch(projects: readonly WatchProject[]) {
    const monitored = new Set<string>();
    for (const project of projects) {
      const marketKey = strengthMarketKey(project);
      if (!marketKey) continue;
      monitored.add(project.id);
      if (this.histories.get(project.id)?.marketKey !== marketKey)
        this.histories.set(project.id, { marketKey, points: [], livePriceAt: null });
    }
    for (const id of this.histories.keys()) if (!monitored.has(id)) this.histories.delete(id);
  }

  /** Replay can fill older seconds. Only a live tick confirms that the latest observed price is current. */
  restore(groups: readonly unknown[], now: number) {
    for (const raw of groups) {
      if (!raw || typeof raw !== 'object') continue;
      const group = raw as Record<string, unknown>;
      if (typeof group.projectId !== 'string' || !Array.isArray(group.points)) continue;
      const history = this.histories.get(group.projectId);
      if (!history || history.marketKey !== group.marketKey) continue;
      prune(history.points, now - STRENGTH_WINDOW_MS);
      const buckets = new Map(history.points.map(point => [Math.floor(point.t / 1000), point]));
      for (const sample of group.points) {
        if (!sample || typeof sample !== 'object') continue;
        const point = quotePoint(sample.t, sample.p, now);
        if (!point) continue;
        const second = Math.floor(point.t / 1000);
        const existing = buckets.get(second);
        if (!existing || point.t > existing.t) buckets.set(second, point);
      }
      history.points = [...buckets.values()].sort((a, b) => a.t - b.t);
    }
  }

  ingest(ticks: readonly unknown[], now: number) {
    for (const raw of ticks) {
      if (!raw || typeof raw !== 'object') continue;
      const tick = raw as Record<string, unknown>;
      if (typeof tick.projectId !== 'string') continue;
      const history = this.histories.get(tick.projectId);
      if (!history || (tick.marketKey != null && tick.marketKey !== history.marketKey)) continue;
      if (tick.stale === true) { history.livePriceAt = null; continue; }
      const point = quotePoint(tick.priceAt ?? tick.at, tick.price, now);
      if (!point) continue;
      const points = history.points;
      prune(points, now - STRENGTH_WINDOW_MS);
      const last = points.at(-1);
      if (last && point.t < last.t) continue;
      history.livePriceAt = point.t;
      if (last && point.t === last.t && point.p === last.p) continue;
      if (last && Math.floor(point.t / 1000) === Math.floor(last.t / 1000)) points[points.length - 1] = point;
      else points.push(point);
    }
  }

  snapshot(now: number) {
    const series = new Map<string, readonly StrengthPoint[]>();
    const staleIds = new Set<string>();
    for (const [id, history] of this.histories) {
      prune(history.points, now - STRENGTH_WINDOW_MS);
      const last = history.points.at(-1);
      if (!last) continue;
      series.set(id, history.points.slice());
      if (last.t !== history.livePriceAt || now - last.t > STRENGTH_GAP_MS) staleIds.add(id);
    }
    return { series, staleIds, now };
  }
}
