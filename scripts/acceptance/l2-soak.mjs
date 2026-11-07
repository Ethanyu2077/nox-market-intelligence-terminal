#!/usr/bin/env node
/**
 * Long-running L2 soak probe. Default 30 minutes, same analyzer as l2-live.
 *
 *   node scripts/acceptance/l2-soak.mjs [apiBase] [minutes]
 *
 * A PASS requires the full continuity criteria for the whole window; a short run or a
 * venue without data stays NOT VERIFIED. No synthetic frames are injected.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { analyzeL2Frames, evaluateL2, buildL2Report } from './lib/l2-analysis.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const minutes = Math.max(1, Number(process.argv[3] ?? 30));
const venues = [['binance', 'BTCUSDT'], ['bybit', 'BTCUSDT'], ['okx', 'BTC-USDT-SWAP']];

async function probe(venue, symbol) {
  const started = Date.now();
  const requestedMs = minutes * 60_000;
  const frames = [];
  let endedEarly = false;
  let noData = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestedMs + 30_000);
  try {
    const response = await fetch(`${base}/api/market/${venue}/${symbol}/book/stream`, { signal: controller.signal });
    if (!response.ok) return { venue, symbol, status: 'NOT VERIFIED', reason: `HTTP ${response.status}` };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastDataAt = Date.now();
    while (Date.now() - started < requestedMs) {
      const remaining = requestedMs - (Date.now() - started);
      const read = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true, timeout: true }), Math.min(10_000, Math.max(1_000, remaining)))),
      ]);
      if (read.done) {
        // A read timeout without data is not a successful completion.
        if (Date.now() - lastDataAt > 15_000) { noData = true; endedEarly = true; }
        else endedEarly = Date.now() - started < requestedMs;
        break;
      }
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split('\n\n'); buffer = blocks.pop();
      for (const block of blocks) {
        const line = block.split('\n').find((row) => row.startsWith('data: '));
        if (!line) continue;
        try { frames.push({ at: Date.now(), snapshot: JSON.parse(line.slice(6)).snapshot }); lastDataAt = Date.now(); } catch { /* malformed */ }
      }
    }
  } catch (error) {
    return { venue, symbol, status: 'NOT VERIFIED', reason: error instanceof Error ? error.message : 'probe failed' };
  } finally { clearTimeout(timer); controller.abort(); }

  const windowEnd = Date.now();
  const metrics = analyzeL2Frames(frames, { requestedMs, windowStart: started, windowEnd });
  const decision = evaluateL2(metrics, { requestedMs });
  const status = endedEarly ? 'FAIL'
    : decision.status === 'PASS' && frames.length > 0 ? 'PASS'
    : metrics.updatedFrames < 2 ? 'NOT VERIFIED' : 'FAIL';
  return buildL2Report(venue, symbol, metrics, {
    status,
    reasons: [...decision.reasons, ...(endedEarly ? [noData ? 'no data within the timeout' : 'SSE ended before the requested window'] : [])],
  }, { endedEarly, noData, framesReceived: frames.length });
}

const results = await Promise.all(venues.map(([venue, symbol]) => probe(venue, symbol).catch((error) => ({ venue, symbol, status: 'NOT VERIFIED', reason: String(error) }))));
await mkdir('artifacts/acceptance', { recursive: true });
const report = { generatedAt: new Date().toISOString(), base, requestedMinutes: minutes, results };
const path = `artifacts/acceptance/l2-soak-${Date.now()}.json`;
await writeFile(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, reportPath: path }, null, 2));
process.exitCode = results.some((row) => row.status === 'FAIL') ? 1 : 0;
