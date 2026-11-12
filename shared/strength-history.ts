import type { MarketProject } from './types.ts';
import { hasMissingQuoteSeconds } from './strength-geometry.ts';

export const STRENGTH_GAP_MS = 5_000;
export const STRENGTH_WINDOW_MS = 60_000;
export type StrengthPoint = { t: number; p: number; compactedBefore?: true };
export type StrengthReturnPoint = { t: number; value: number; compactedBefore?: true };
export type LiveStrengthReturn = { points: StrengthReturnPoint[]; latest: number | null; stale: boolean };
export type WatchProject = Pick<MarketProject, 'id' | 'markets' | 'primaryMarketId'>;
interface History {
  marketKey: string;
  points: StrengthPoint[];
  livePriceAt: number | null;
  origin: StrengthPoint | null;
}

export function strengthMarketKey(project: WatchProject) {
  const market = project.markets.find(item => item.id === project.primaryMarketId) ?? project.markets[0];
  return market ? `${market.exchange}:${market.marketType}:${market.symbol}` : null;
}

// Keep the replay horizon at full resolution. Bound an open tab's older history
// with time buckets that retain real endpoints, extrema and the largest outage.
const MAX_SESSION_POINTS = 2048;
function compact(points: StrengthPoint[], now: number): StrengthPoint[] {
  if (points.length <= MAX_SESSION_POINTS) return points;
  const cutoff = now - STRENGTH_WINDOW_MS;
  const origin = points[0].t;
  const bucketMs = 1000 * 2 ** Math.max(0, Math.ceil(Math.log2((cutoff - origin) / 256_000)));
  const kept: StrengthPoint[] = [];
  let previousIndex = -1;
  let i = 0;
  while (i < points.length && points[i].t < cutoff) {
    const first = i;
    const end = Math.min(cutoff, origin + (Math.floor((points[i].t - origin) / bucketMs) + 1) * bucketMs);
    let min = i, max = i, gap = i, longestGap = 0;
    for (i++; i < points.length && points[i].t < end; i++) {
      if (points[i].p < points[min].p) min = i;
      if (points[i].p > points[max].p) max = i;
      const elapsed = Math.floor(points[i].t / 1000) - Math.floor(points[i - 1].t / 1000);
      if (elapsed > longestGap && hasMissingQuoteSeconds(points[i - 1], points[i])) {
        gap = i;
        longestGap = elapsed;
      }
    }
    const indices = new Set([first, min, max, i - 1]);
    if (longestGap) { indices.add(gap - 1); indices.add(gap); }
    for (const index of [...indices].sort((a, b) => a - b)) {
      const p = points[index];
      kept.push(index > previousIndex + 1 ? { ...p, compactedBefore: true } : p);
      previousIndex = index;
    }
  }
  return kept.concat(points.slice(i));
}

function quotePoint(t: unknown, p: unknown, now: number, start: number): StrengthPoint | null {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t < Math.max(start, now - STRENGTH_WINDOW_MS) || t > now + STRENGTH_GAP_MS) return null;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return null;
  return { t, p };
}

/** Returns use the session's pinned first price; only fresh quotes participate in live rankings. */
export function liveStrengthReturns(
  series: ReadonlyMap<string, readonly StrengthPoint[]>,
  now: number,
  staleIds: ReadonlySet<string>,
  connected: boolean,
): Map<string, LiveStrengthReturn> {
  const returns = new Map<string, LiveStrengthReturn>();
  for (const [id, samples] of series) {
    const observed = samples.filter(point => point.t > 0 && point.t <= now && Number.isFinite(point.p) && point.p > 0);
    if (!observed.length) continue;
    const base = observed[0].p;
    const points = observed.map(({ t, p, ...sampling }) => ({ t, value: (p - base) / base * 100, ...sampling }));
    const last = points[points.length - 1];
    const stale = !connected || staleIds.has(id) || now - last.t > STRENGTH_GAP_MS;
    returns.set(id, { points, latest: stale ? null : last.value, stale });
  }
  return returns;
}

/** Read a recent observed value, except inside a confirmed gap between quotes. */
export function strengthValueAt(
  points: readonly { t: number; value: number | null; compactedBefore?: true }[],
  time: number,
  maxGapMs = STRENGTH_GAP_MS,
): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point.t > time) continue;
    if (point.t === time) return point.value;
    const next = points[i + 1];
    if (next && (hasMissingQuoteSeconds(point, next) || next.compactedBefore)) return null;
    return time - point.t <= maxGapMs ? point.value : null;
  }
  return null;
}

export class StrengthHistory {
  private histories = new Map<string, History>();
  private pinnedStart: number | null = null;

  constructor(private readonly earliestStart: number) {}

  watch(projects: readonly WatchProject[]) {
    const monitored = new Set<string>();
    for (const project of projects) {
      const marketKey = strengthMarketKey(project);
      if (!marketKey) continue;
      monitored.add(project.id);
      if (this.histories.get(project.id)?.marketKey !== marketKey)
        this.histories.set(project.id, { marketKey, points: [], livePriceAt: null, origin: null });
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
      const buckets = new Map(history.points.map(point => [Math.floor(point.t / 1000), point]));
      for (const sample of group.points) {
        if (!sample || typeof sample !== 'object') continue;
        const point = quotePoint(sample.t, sample.p, now, this.pinnedStart ?? this.earliestStart);
        if (!point || (history.origin && point.t <= history.origin.t)) continue;
        const second = Math.floor(point.t / 1000);
        const existing = buckets.get(second);
        if (!existing || point.t > existing.t) buckets.set(second, point);
      }
      const points = [...buckets.values()].sort((a, b) => a.t - b.t);
      if (history.origin && points[0] !== history.origin) points.unshift(history.origin);
      history.points = compact(points, now);
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
      const point = quotePoint(tick.priceAt ?? tick.at, tick.price, now, this.pinnedStart ?? this.earliestStart);
      if (!point) continue;
      const points = history.points;
      const last = points.at(-1);
      if (last && point.t < last.t) continue;
      history.livePriceAt = point.t;
      if (last && point.t === last.t && (last === history.origin || point.p === last.p)) continue;
      if (last && last !== history.origin && Math.floor(point.t / 1000) === Math.floor(last.t / 1000)) points[points.length - 1] = point;
      else points.push(point);
      history.points = compact(points, now);
    }
  }

  snapshot(now: number) {
    const series = new Map<string, readonly StrengthPoint[]>();
    const staleIds = new Set<string>();
    let firstTime = Infinity;
    for (const [id, history] of this.histories) {
      const observed = history.points.filter(point => point.t <= now);
      const last = observed.at(-1);
      if (!last) continue;
      history.origin ??= observed[0];
      firstTime = Math.min(firstTime, history.origin.t);
      series.set(id, observed);
      if (last.t !== history.livePriceAt || now - last.t > STRENGTH_GAP_MS) staleIds.add(id);
    }
    if (this.pinnedStart === null && Number.isFinite(firstTime)) this.pinnedStart = firstTime;
    return { series, staleIds, now, start: this.pinnedStart ?? this.earliestStart };
  }
}
