// Fetch Binance USDT-M 5m klines and 5m OI history per symbol (DAYS, WARMUP_BARS, OUT_DIR env; defaults 7 days -> ./data/).
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = new URL(process.env.OUT_DIR ?? './data/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const REST = 'https://fapi.binance.com';
const STEP = 300_000;
const DAYS = Number(process.env.DAYS ?? 7), WARMUP_BARS = Number(process.env.WARMUP_BARS ?? 300); // warm-up feeds the point-in-time OI/flow baselines
const end = Math.floor(Date.now() / STEP) * STEP; // last closed 5m boundary
const start = end - DAYS * 86_400_000 - WARMUP_BARS * STEP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(REST + path, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error(`${res.status} ${path}: ${await res.text()}`);
  }
  throw new Error(`retries exhausted ${path}`);
}
async function klines(symbol) {
  const rows = new Map();
  for (let from = start; from < end;) {
    const batch = await get(`/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${from}&endTime=${end - 1}&limit=1500`);
    if (!batch.length) break;
    for (const k of batch) rows.set(k[0], k);
    from = batch.at(-1)[0] + STEP;
    await sleep(150);
  }
  // keep only closed candles
  return [...rows.values()].filter((k) => k[6] < end).sort((a, b) => a[0] - b[0]);
}
async function oiHist(symbol) {
  const rows = new Map();
  for (let from = start; from < end; from += 500 * STEP) {
    const to = Math.min(end, from + 500 * STEP) - 1;
    const batch = await get(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&startTime=${from}&endTime=${to}&limit=500`);
    for (const o of batch) rows.set(o.timestamp, o);
    await sleep(250);
  }
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}
const symbols = process.argv.slice(2);
for (const symbol of symbols) {
  const [k, oi] = [await klines(symbol), await oiHist(symbol)];
  writeFileSync(new URL(`${symbol}.json`, OUT), JSON.stringify({ symbol, fetchedAt: Date.now(), start, end, klines: k, oi }));
  console.log(symbol, 'klines', k.length, 'oi', oi.length, new Date(k[0]?.[0]).toISOString(), '→', new Date(k.at(-1)?.[0]).toISOString());
}
