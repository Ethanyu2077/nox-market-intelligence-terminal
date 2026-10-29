// Sensitivity: does label accuracy improve for stronger signals or non-overlapping samples?
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [calcPath, ...symbols] = process.argv.slice(2);
const { computeOiDeltas, detectPositionFlowSignals } = await import(pathToFileURL(calcPath).href);
const DIR = { potential_long_buildup: 1, potential_short_covering: 1, potential_short_buildup: -1, potential_long_liquidation: -1 };
const H = 12, COST = 0.10;
const pool = { all: [], spike: [], conf70: [], nonOverlap: [], baseline: [] };
let bars = 0, labelled = 0;
for (const symbol of symbols) {
  const raw = JSON.parse(readFileSync(new URL(`./data/${symbol}.json`, import.meta.url)));
  const candles = raw.klines.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volumeBase: +k[5], volumeUsd: +k[7] }));
  const flow = raw.klines.map((k) => { const b = +k[10], s = +k[7] - b; return { time: k[0], value: b - s, buyNotional: b, sellNotional: s, deltaNotional: b - s, imbalancePct: 0, deltaChangePct: null, complete: true }; });
  const oi = computeOiDeltas(raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterest })), raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterestValue })));
  const evalStart = raw.end - 7 * 86_400_000;
  const byId = new Map();
  for (let i = 1; i < oi.length; i += 60) for (const s of detectPositionFlowSignals(candles, oi.slice(i - 1, i + 60), flow)) byId.set(s.id, s);
  const idx = new Map(candles.map((c, i) => [c.time, i]));
  const spikeAt = new Map(oi.map((p) => [p.time, p.spike]));
  const fwd = (i) => { const e = candles[i + H - 1]; return e ? (e.close - candles[i].open) / candles[i].open * 100 : null; };
  const sigs = [...byId.values()].filter((s) => s.time >= evalStart && DIR[s.type]).sort((a, b) => a.time - b.time);
  bars += candles.filter((c) => c.time >= evalStart).length; labelled += new Set([...byId.values()].filter((s) => s.time >= evalStart).map((s) => s.time)).size;
  let nextFree = -Infinity;
  for (const s of sigs) {
    const i = idx.get(s.time), v = i == null ? null : fwd(i); if (v == null) continue;
    const d = v * DIR[s.type];
    pool.all.push(d);
    if (spikeAt.get(s.time)) pool.spike.push(d);
    if (s.confidence >= 70) pool.conf70.push(d);
    if (s.time >= nextFree) { pool.nonOverlap.push(d); nextFree = s.time + H * 300_000; }
  }
  // Baseline: random direction-free reference = |long| and |short| both scored, i.e. 50/50 mix of directions.
  candles.forEach((c, i) => { if (c.time >= evalStart) { const v = fwd(i); if (v != null) pool.baseline.push(v, -v); } });
}
const stats = (v) => ({ n: v.length, hit: +(v.filter((x) => x > 0).length / v.length * 100).toFixed(1), netHit: +(v.filter((x) => x - COST > 0).length / v.length * 100).toFixed(1), meanDir: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), meanNet: +(v.reduce((a, b) => a + b - COST, 0) / v.length).toFixed(3) });
console.log(`bars=${bars} barsWithAnyLabel=${labelled} (${(labelled / bars * 100).toFixed(1)}%)`);
for (const [k, v] of Object.entries(pool)) console.log(k.padEnd(11), JSON.stringify(stats(v)));
