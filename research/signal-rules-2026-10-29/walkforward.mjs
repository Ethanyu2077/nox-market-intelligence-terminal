// Walk-forward comparison of NOX signal-rule variants on 28 days of 5m Binance data.
// Rules fixed before running: choose the variant with the best non-overlapping 60m net directional
// return on the TRAIN period (min 100 samples), then report it on the untouched TEST period.
// Usage: node --import <tsx> walkforward.mjs <NOX calculations.ts> SYMBOL...
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { researchWindow } from '../../shared/research-window.ts';
const [calcPath, ...symbols] = process.argv.slice(2);
const { computeOiDeltas, detectPositionFlowSignals } = await import(pathToFileURL(calcPath).href);

const STEP = 300_000, DAY = 86_400_000, COST = 0.10, MIN_TRAIN = 100, PRIMARY = 12;
const HORIZONS = [3, 12, 48];
const DIR = { potential_long_buildup: 1, potential_short_covering: 1, potential_short_buildup: -1, potential_long_liquidation: -1 };

const variants = [];
for (const windowSteps of [1, 3, 12]) for (const q of [null, 0.8, 0.9]) for (const minFlowImbalancePct of [0, 15]) {
  variants.push({
    name: `w${windowSteps * 5}m ${q == null ? 'fixed' : `q${q * 100}`} imb${minFlowImbalancePct}`,
    current: windowSteps === 1 && q == null && minFlowImbalancePct === 0,
    rules: { windowSteps, minFlowImbalancePct, limit: Infinity, adaptive: q == null ? null : { quantile: q, lookbackWindows: 288, minHistory: 144 } },
  });
}

const markets = symbols.map((symbol) => {
  const raw = JSON.parse(readFileSync(new URL(`./data30/${symbol}.json`, import.meta.url)));
  const candles = raw.klines.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volumeBase: +k[5], volumeUsd: +k[7] }));
  const flow = raw.klines.map((k) => { const b = +k[10], s = +k[7] - b, d = b - s; return { time: k[0], value: d, buyNotional: b, sellNotional: s, deltaNotional: d, imbalancePct: b + s ? d / (b + s) * 100 : 0, deltaChangePct: null, complete: true }; });
  const oi = computeOiDeltas(raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterest })), raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterestValue })));
  return { symbol, candles, flow, oi, index: new Map(candles.map((c, i) => [c.time, i])), end: raw.end };
});
const end = Math.min(...markets.map((m) => m.end)), evalStart = end - 28 * DAY, split = evalStart + 19 * DAY;
const period = (t) => t >= evalStart && t < split ? 'train' : t >= split && t < end ? 'test' : null;

function forward(m, i, h, delay = 0) {
  const p = period(m.candles[i]?.time);
  if (!p) return null;
  return researchWindow(m.candles, i, h, { availableAt: m.candles[i].time, delayBars: delay,
    start: p === 'train' ? evalStart : split, end: p === 'train' ? split : end })?.priceReturnPct ?? null;
}
const mean = (v) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
const sd = (v) => { const m = mean(v); return v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : null; };

// Baseline hit rate by period/horizon/direction: every bar in the period.
const baseline = {};
for (const p of ['train', 'test']) for (const h of HORIZONS) {
  const up = [];
  for (const m of markets) m.candles.forEach((c, i) => { if (period(c.time) === p) { const v = forward(m, i, h); if (v != null) up.push(v); } });
  baseline[`${p}:${h}`] = { up: up.filter((v) => v > 0).length / up.length * 100, down: up.filter((v) => v < 0).length / up.length * 100, bars: up.length };
}

function evaluate(signalsByMarket, p, h, delay = 0) {
  const all = [], free = [], byType = {};
  let labelledBars = 0, bars = 0, baseHits = 0, withheldDirectional = 0;
  for (const { m, signals } of signalsByMarket) {
    bars += m.candles.filter((c) => period(c.time) === p).length;
    labelledBars += new Set(signals.filter((s) => period(s.time) === p).map((s) => s.time)).size;
    let nextFree = -Infinity;
    for (const s of signals) {
      if (period(s.time) !== p || !DIR[s.type]) continue;
      if (s.status !== 'hypothesis') { withheldDirectional++; continue; }
      const i = m.index.get(s.time); const v = i == null ? null : forward(m, i, h, delay);
      if (v == null) continue;
      const d = v * DIR[s.type];
      all.push(d); (byType[s.type] ??= []).push(d);
      baseHits += (DIR[s.type] > 0 ? baseline[`${p}:${h}`].up : baseline[`${p}:${h}`].down) / 100;
      if (s.time >= nextFree) { free.push(d); nextFree = s.time + h * STEP; }
    }
  }
  const hit = (v) => v.length ? v.filter((x) => x > 0).length / v.length * 100 : null;
  const net = free.map((x) => x - COST);
  return {
    fireRatePct: bars ? labelledBars / bars * 100 : null,
    withheldDirectional,
    n: all.length, hit: hit(all), baselineHit: delay ? null : all.length ? baseHits / all.length * 100 : null,
    nFree: free.length, hitFree: hit(free), netMeanFree: mean(net), netT: net.length > 1 ? mean(net) / (sd(net) / Math.sqrt(net.length)) : null,
    grossMeanFree: mean(free),
    byType: Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, { n: v.length, hit: hit(v), mean: mean(v) }])),
  };
}

const rows = [];
for (const v of variants) {
  const signalsByMarket = markets.map((m) => ({ m, signals: detectPositionFlowSignals(m.candles, m.oi, m.flow, end, v.rules).sort((a, b) => a.time - b.time) }));
  const row = { name: v.name, current: v.current, rules: v.rules };
  for (const p of ['train', 'test']) for (const h of HORIZONS) row[`${p}:${h}`] = evaluate(signalsByMarket, p, h);
  row.delayedTest = evaluate(signalsByMarket, 'test', PRIMARY, 1);
  rows.push(row);
  console.error('done', v.name);
}
const eligible = rows.filter((r) => r[`train:${PRIMARY}`].nFree >= MIN_TRAIN);
const selected = [...eligible].sort((a, b) => b[`train:${PRIMARY}`].netMeanFree - a[`train:${PRIMARY}`].netMeanFree)[0];
writeFileSync(new URL('./results/walkforward-v3.json', import.meta.url), JSON.stringify({ version: 'nox-research-v3', boundary: 'entry >= period start; exit close <= period end; no cross-boundary labels', evidenceGate: 'hypothesis only; withheld counts reported separately', cost: 'flat 10bps round-trip sensitivity, not execution-ledger/account PnL; funding unavailable', availableAt: 'theoretical signal boundary; historical ingest latency unavailable', evalStart, split, end, baseline, selected: selected?.name, rows }));

const f = (x, d = 1) => x == null ? '—' : x.toFixed(d);
console.log(`eval ${new Date(evalStart).toISOString()} | split ${new Date(split).toISOString()} | end ${new Date(end).toISOString()}`);
console.log('variant              | TRAIN 60m: fire%  n  hit/base  nFree hitFree net%  t     | TEST 60m: fire%  n  hit/base  nFree hitFree net%  t');
for (const r of rows) {
  const a = r[`train:${PRIMARY}`], b = r[`test:${PRIMARY}`];
  console.log(`${(r.name + (r.current ? ' *cur' : '') + (r === selected ? ' *SEL' : '')).padEnd(21)}| ${f(a.fireRatePct).padStart(5)} ${String(a.n).padStart(5)} ${f(a.hit)}/${f(a.baselineHit)} ${String(a.nFree).padStart(5)} ${f(a.hitFree)} ${f(a.netMeanFree, 3)} ${f(a.netT, 2)} | ${f(b.fireRatePct).padStart(5)} ${String(b.n).padStart(5)} ${f(b.hit)}/${f(b.baselineHit)} ${String(b.nFree).padStart(5)} ${f(b.hitFree)} ${f(b.netMeanFree, 3)} ${f(b.netT, 2)}`);
}
if (selected) {
  console.log('\nSELECTED', selected.name);
  for (const h of HORIZONS) for (const p of ['train', 'test']) { const e = selected[`${p}:${h}`]; console.log(p, `${h * 5}m`, `n=${e.n} hit=${f(e.hit)} base=${f(e.baselineHit)} nFree=${e.nFree} hitFree=${f(e.hitFree)} netFree=${f(e.netMeanFree, 3)} t=${f(e.netT, 2)} gross=${f(e.grossMeanFree, 3)}`); }
  const d = selected.delayedTest; console.log('test 60m entry +1 bar', `nFree=${d.nFree} hitFree=${f(d.hitFree)} netFree=${f(d.netMeanFree, 3)} t=${f(d.netT, 2)}`);
  console.log('test 60m by label', JSON.stringify(selected[`test:${PRIMARY}`].byType));
}
