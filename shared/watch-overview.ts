export const BUCKET = 300_000;
export type WatchCandle = { time: number; close: number; volume: number };
export type WatchFlowBucket = { time: number; buy: number | null; sell: number | null; delta: number | null; cvd: number | null };
export type WatchFlow = {
  buy: number | null; sell: number | null; delta: number | null; cvd: number | null;
  spotDelta: number | null; perpDelta: number | null;
  buckets: WatchFlowBucket[];
  covered: number; requested: number;
  source: 'orderflow';
};
export type WatchOiPoint = { time: number; oiUsd: number };
export type WatchRow = { projectId: string; venue: string; symbol: string; marketType: string; quote: string; candles: WatchCandle[]; error: string | null; funding?: { rate: number; hours: number; time: number } | null;
  flow?: WatchFlow | null; oiSeries?: WatchOiPoint[]; }
export type WatchOverview = { asOf: number; end: number; rows: WatchRow[]; benchmarks: WatchRow[] };
export function windowPoints(candles: WatchCandle[], end: number, minutes: number): WatchCandle[] | null {
  const start = end - minutes * 60_000;
  const points = candles.filter(p => p.time >= start && p.time <= end).sort((a,b)=>a.time-b.time);
  if (points.length !== minutes / 5 + 1 || points.some((p,i)=>p.time !== start+i*BUCKET || !Number.isFinite(p.close) || p.close <= 0)) return null;
  return points;
}
export function performance(candles: WatchCandle[], end: number, minutes: number): number | null {
  const points = windowPoints(candles,end,minutes);
  return points ? (points.at(-1)!.close/points[0].close-1)*100 : null;
}
export function volumeRatio(candles: WatchCandle[], index: number): number | null {
  if(index < 12) return null;
  const sample=candles.slice(index-12,index);
  if(sample.some((p,i)=>p.time !== candles[index].time-(12-i)*BUCKET || !Number.isFinite(p.volume) || p.volume<0)) return null;
  const sorted=sample.map(p=>p.volume).sort((a,b)=>a-b); const median=(sorted[5]+sorted[6])/2;
  return median>0 && Number.isFinite(candles[index].volume) && candles[index].volume>=0 ? candles[index].volume/median : null;
}
