import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [newPath, oldPath, ...symbols] = process.argv.slice(2);
const now = await import(pathToFileURL(newPath).href), old = await import(pathToFileURL(oldPath).href);
for (const symbol of symbols) {
  const raw = JSON.parse(readFileSync(new URL(`./data/${symbol}.json`, import.meta.url)));
  const candles = raw.klines.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volumeBase: +k[5], volumeUsd: +k[7] }));
  const flow = raw.klines.map((k) => { const b = +k[10], s = +k[7] - b; return { time: k[0], value: b - s, buyNotional: b, sellNotional: s, deltaNotional: b - s, imbalancePct: 0, deltaChangePct: null, complete: true }; });
  const oi = old.computeOiDeltas(raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterest })), raw.oi.map((o) => ({ time: o.timestamp, value: +o.sumOpenInterestValue })));
  const a = new Map(), b = new Map();
  for (let i = 1; i < oi.length; i += 60) for (const s of old.detectPositionFlowSignals(candles, oi.slice(i - 1, i + 60), flow, 0)) a.set(s.id, s);
  for (const s of now.detectPositionFlowSignals(candles, oi, flow, 0, { limit: Infinity })) b.set(s.id, s);
  const onlyOld = [...a.keys()].filter((k) => !b.has(k)), onlyNew = [...b.keys()].filter((k) => !a.has(k));
  const changed = [...a.keys()].filter((k) => b.has(k) && JSON.stringify({ ...a.get(k), evidence: 0, observed: 0 }) !== JSON.stringify({ ...b.get(k), evidence: 0, observed: 0 }));
  console.log(symbol, 'old', a.size, 'new', b.size, 'onlyOld', onlyOld.length, onlyOld.slice(0, 2).join(','), 'onlyNew', onlyNew.length, 'changedFields', changed.length);
}
