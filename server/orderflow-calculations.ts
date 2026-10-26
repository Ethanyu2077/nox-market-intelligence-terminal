import { FLOW_INTERVALS, type FlowBucket, type FlowGap, type FlowInterval, type FlowReset, type FlowSignal, type FlowTrade, type FlowTradeCluster, type FlowVenue } from '../shared/orderflow.ts';

export const flowKey = (m: { exchange: string; marketType: string; symbol: string }) => `${m.exchange}:${m.marketType}:${m.symbol}`;
export function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; }
export function robustZ(value: number, history: number[]): number | null {
  if (history.length < 20) return null;
  const center = median(history)!; const mad = median(history.map(v => Math.abs(v - center)))!;
  return mad > 0 ? (value - center) / (1.4826 * mad) : null;
}
export function timeGrid(now: number, interval: FlowInterval, length = 60) {
  const step = FLOW_INTERVALS[interval], end = Math.floor(now / step) * step;
  return Array.from({ length }, (_, i) => end - (length - 1 - i) * step);
}
export function flowBuckets(trades: FlowTrade[], interval: FlowInterval, reset: FlowReset, times: number[], coverage: { from: number | null; to: number | null; gaps: FlowGap[] }): FlowBucket[] {
  const step = FLOW_INTERVALS[interval]; const grouped = new Map<number, FlowTrade[]>();
  for (const trade of trades) { const time = Math.floor(trade.time / step) * step; const group = grouped.get(time) ?? []; group.push(trade); grouped.set(time, group); }
  let cvd = 0, lastReset = '', continuity = false;
  const history: number[] = [];
  return times.map(time => {
    const group = grouped.get(time) ?? [];
    const complete = coverage.from != null && coverage.to != null && time >= coverage.from && time + step <= coverage.to && !coverage.gaps.some(g => g.from < time + step && g.to > time);
    const known = group.length > 0 || complete;
    const buy = known ? group.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.notional, 0) : null;
    const sell = known ? group.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.notional, 0) : null;
    const delta = buy == null || sell == null ? null : buy - sell;
    const resetKey = reset === 'window' ? 'window' : String(Math.floor(time / (reset === 'utc-day' ? 86_400_000 : 3_600_000)));
    const didReset = resetKey !== lastReset || !continuity;
    if (didReset) cvd = 0;
    // CVD may begin only at a fully covered bucket, never bridge an incomplete bucket or a gap.
    const overlapsGap = coverage.gaps.some(g => g.from < time + step && g.to > time);
    const cvdValue = known && delta != null && !overlapsGap ? (cvd += delta) : null;
    const zScore = complete && delta != null ? robustZ(delta, history.slice(-60)) : null;
    if (complete && delta != null) history.push(delta);
    continuity = complete; lastReset = resetKey;
    return { time, buy, sell, delta, cvd: cvdValue, complete, count: group.length, zScore, reset: didReset };
  });
}
export function aggregateFlow(venues: FlowVenue[], times: number[], interval: FlowInterval, reset: FlowReset): FlowBucket[] {
  let cumulative = 0, previousReset = '', continuous = false;
  return times.map((time, index) => {
    const rows = venues.map(v => v.buckets[index]);
    const complete = rows.length > 0 && rows.every(row => row?.time === time && row.complete && row.delta != null);
    const key = reset === 'window' ? 'window' : String(Math.floor(time / (reset === 'utc-day' ? 86_400_000 : 3_600_000)));
    const didReset = key !== previousReset || !continuous;
    if (didReset) cumulative = 0;
    const sum = (metric: 'buy' | 'sell' | 'delta') => complete ? rows.reduce((total, row) => total + row[metric]!, 0) : null;
    const delta = sum('delta'); if (delta != null) cumulative += delta;
    continuous = complete; previousReset = key;
    void interval;
    return { time, buy: sum('buy'), sell: sum('sell'), delta, cvd: complete ? cumulative : null, complete, count: complete ? rows.reduce((n, row) => n + row.count, 0) : 0, zScore: null, reset: didReset };
  });
}
export function flowDivergences(spot: FlowBucket[], perp: FlowBucket[], now: number): FlowSignal[] {
  // Only simultaneous completed buckets with at least 20 prior observations per side qualify.
  const pairs = spot.map((s, i) => ({ s, p: perp[i] })).filter(({ s, p }) => s.complete && p?.complete && s.time === p.time && s.delta != null && p.delta != null);
  if (pairs.length < 21) return [];
  const { s, p } = pairs.at(-1)!;
  const spotZ = robustZ(s.delta!, pairs.slice(0, -1).map(r => r.s.delta!)), perpZ = robustZ(p.delta!, pairs.slice(0, -1).map(r => r.p.delta!));
  if (spotZ == null || perpZ == null || Math.abs(spotZ) < 2 || Math.abs(perpZ) < 2 || now - s.time > 2 * (spot.at(-1)!.time - spot.at(-2)!.time)) return [];
  const label = s.delta! > 0 ? (p.delta! > 0 ? 'Synchronized Spot and Perp Buying' : 'Spot Buying / Perp Selling') : (p.delta! > 0 ? 'Spot Selling / Perp Buying' : 'Synchronized Spot and Perp Selling');
  return [{ id: `flow:${s.time}:${label}`, label, classification: 'hypothesis', confidence: Math.min(.85, .5 + Math.min(Math.abs(spotZ), Math.abs(perpZ)) * .05), evidence: [`Spot delta ${s.delta} USDT; robust z ${spotZ.toFixed(2)}`, `Perpetual delta ${p.delta} USDT; robust z ${perpZ.toFixed(2)}`, `${pairs.length - 1} prior aligned completed buckets; |z| ≥ 2 on both sides`], missing: ['Heuristic confidence is not a calibrated forecast.', 'Trade flow and public OI do not reveal individual position opening/closing.'], timestamp: s.time }];
}

export function tradeSizeRatio(trade: FlowTrade, earlier: FlowTrade[]) {
  const sample = earlier.filter(t => flowKey(t) === flowKey(trade) && t.time < trade.time).slice(-200).map(t => t.notional);
  const baseline = sample.length >= 20 ? median(sample) : null;
  return baseline && baseline > 0 ? trade.notional / baseline : null;
}
export function clusterFlowTrades(trades: FlowTrade[], windowMs = 2000): FlowTradeCluster[] {
  const groups = new Map<string, FlowTradeCluster>();
  for (const trade of trades) {
    const id = `${flowKey(trade)}:${trade.side}:${Math.floor(trade.time / windowMs)}`;
    const group = groups.get(id) ?? { id, exchange: trade.exchange, marketType: trade.marketType, symbol: trade.symbol, side: trade.side, from: trade.time, to: trade.time, notional: 0, quantity: 0, tradeIds: [] };
    if (group.tradeIds.includes(trade.id)) continue;
    group.from = Math.min(group.from, trade.time); group.to = Math.max(group.to, trade.time); group.notional += trade.notional; group.quantity += trade.quantity; group.tradeIds.push(trade.id); groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => b.to - a.to);
}
