// Backtest NOX position-flow labels on 7 days of 5m Binance data, using NOX's own label code.
// Usage: node --import <tsx> backtest.mjs <path-to-NOX-calculations.ts> SYMBOL...
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [calcPath, ...symbols] = process.argv.slice(2);
const { computeOiDeltas, detectPositionFlowSignals } = await import(pathToFileURL(calcPath).href);

const HORIZONS = [3, 12, 48], COST_PCT = 0.10; // Legacy study; use walkforward.mjs for V3 boundary/evidence gates.
const DIRECTION = { potential_long_buildup: 1, potential_short_covering: 1, potential_short_buildup: -1, potential_long_liquidation: -1 };

function load(symbol) {
  const raw = JSON.parse(readFileSync(new URL(`./data/${symbol}.json`, import.meta.url)));
  const candles = raw.klines.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volumeBase: +k[5], volumeUsd: +k[7] }));
  // Kline taker-buy quote volume gives exact per-candle aggressor flow (same buyer-maker definition
  // as aggTrades), so every bucket is complete. Live NOX only sees the latest 1000 aggTrades.
  const volumeFlow = raw.klines.map((k) => {
    const buy = +k[10], sell = +k[7] - +k[10], delta = buy - sell, gross = buy + sell;
    return { time: k[0], value: delta, buyNotional: buy, sellNotional: sell, deltaNotional: delta, imbalancePct: gross ? delta / gross * 100 : 0, deltaChangePct: null, complete: true };
  });
  const oiBase = raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterest }));
  const oiUsd = raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterestValue }));
  return { evalStart: raw.end - 7 * 86_400_000, end: raw.end, candles, volumeFlow, oiDelta: computeOiDeltas(oiBase, oiUsd) };
}

// detectPositionFlowSignals keeps only its latest 80 signals, so run it over 60-window slices of the
// precomputed (point-in-time) OI deltas and merge by id.
function allSignals({ candles, oiDelta, volumeFlow }) {
  const byId = new Map();
  for (let i = 1; i < oiDelta.length; i += 60) {
    for (const s of detectPositionFlowSignals(candles, oiDelta.slice(i - 1, i + 60), volumeFlow)) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => a.time - b.time);
}

function forward(candles, index, h) { // NOX convention: enter at signal bar open, exit at close of bar h-1
  const exit = candles[index + h - 1];
  return exit && candles[index].open ? (exit.close - candles[index].open) / candles[index].open * 100 : null;
}
const mean = (v) => v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const results = [];
for (const symbol of symbols) {
  const data = load(symbol);
  const index = new Map(data.candles.map((c, i) => [c.time, i]));
  const evalBars = data.candles.map((c, i) => [c, i]).filter(([c]) => c.time >= data.evalStart);
  const signals = allSignals(data).filter((s) => s.time >= data.evalStart);
  for (const h of HORIZONS) {
    const baseline = evalBars.map(([, i]) => forward(data.candles, i, h)).filter((v) => v != null);
    for (const type of [...new Set(signals.map((s) => s.type))]) {
      const group = signals.filter((s) => s.type === type);
      const outcomes = group.flatMap((s) => { const i = index.get(s.time); const v = i == null ? null : forward(data.candles, i, h); return v == null ? [] : [v]; });
      const dir = DIRECTION[type] ?? null;
      const directional = dir == null ? [] : outcomes.map((v) => v * dir);
      const baseDir = dir == null ? [] : baseline.map((v) => v * dir);
      results.push({
        symbol, horizonBars: h, type, status: group.some((s) => s.status === 'withheld') ? 'withheld-by-NOX' : 'hypothesis',
        signals: group.length, resolved: outcomes.length, direction: dir,
        hitRate: dir == null || !outcomes.length ? null : directional.filter((v) => v > 0).length / outcomes.length * 100,
        netHitRate: dir == null || !outcomes.length ? null : directional.filter((v) => v - COST_PCT > 0).length / outcomes.length * 100,
        baselineHitRate: dir == null ? null : baseDir.filter((v) => v > 0).length / baseDir.length * 100,
        meanDirectionalPct: mean(directional), medianDirectionalPct: median(directional), baselineMeanDirectionalPct: mean(baseDir),
        meanAbsMovePct: mean(outcomes.map(Math.abs)), baselineMeanAbsMovePct: mean(baseline.map(Math.abs)),
        directional, baseDir,
      });
    }
  }
  console.error(symbol, 'signals in 7d:', signals.length);
}
writeFileSync(new URL('./results/results-7d.json', import.meta.url), JSON.stringify(results));

// Pooled table across tokens.
const fmt = (v, d = 1) => v == null ? '—' : v.toFixed(d);
const rows = [];
for (const h of HORIZONS) for (const type of [...new Set(results.map((r) => r.type))]) {
  const g = results.filter((r) => r.horizonBars === h && r.type === type);
  const d = g.flatMap((r) => r.directional), b = g.flatMap((r) => r.baseDir), n = g.reduce((s, r) => s + r.resolved, 0);
  const dir = g[0].direction;
  const hit = dir == null || !d.length ? null : d.filter((v) => v > 0).length / d.length * 100;
  const base = dir == null || !b.length ? null : b.filter((v) => v > 0).length / b.length * 100;
  // Binomial z vs baseline rate (ignores overlap/autocorrelation; indicative only).
  const z = hit != null && base != null && n ? (hit / 100 - base / 100) / Math.sqrt(base / 100 * (1 - base / 100) / n) : null;
  rows.push({ h, type, n, hit, net: dir == null || !d.length ? null : d.filter((v) => v - COST_PCT > 0).length / d.length * 100, base, lift: hit != null && base != null ? hit - base : null, z, meanDir: mean(d), absMove: mean(g.flatMap((r) => r.resolved ? [r.meanAbsMovePct * r.resolved] : [])) });
}
console.log('POOLED');
for (const r of rows) console.log([`${r.h * 5}m`, r.type, `n=${r.n}`, `hit=${fmt(r.hit)}`, `net=${fmt(r.net)}`, `base=${fmt(r.base)}`, `lift=${fmt(r.lift)}`, `z=${fmt(r.z, 2)}`, `meanDir=${fmt(r.meanDir, 3)}`].join('  '));
console.log('PER TOKEN (60m horizon)');
for (const r of results.filter((x) => x.horizonBars === 12)) console.log([r.symbol, r.type, r.status, `n=${r.resolved}`, `hit=${fmt(r.hitRate)}`, `net=${fmt(r.netHitRate)}`, `base=${fmt(r.baselineHitRate)}`, `meanDir=${fmt(r.meanDirectionalPct, 3)}`, `absMove=${fmt(r.meanAbsMovePct, 3)}/${fmt(r.baselineMeanAbsMovePct, 3)}`].join('  '));
