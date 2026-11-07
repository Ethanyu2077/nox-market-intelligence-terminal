#!/usr/bin/env node
/**
 * Repeatable live L2 acceptance probe. Reads the public API only; it does not claim
 * success when the venue is unreachable and never fabricates a state.
 *
 *   node scripts/acceptance/l2-live.mjs [apiBase] [seconds]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const seconds = Number(process.argv[3] ?? 20);
const venues = [['binance', 'BTCUSDT'], ['bybit', 'BTCUSDT'], ['okx', 'BTC-USDT-SWAP']];

async function probe(venue, symbol) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/market/${venue}/${symbol}/book/stream`, { signal: controller.signal });
  if (!response.ok) return { venue, symbol, status: 'NOT VERIFIED', reason: `HTTP ${response.status}` };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', last = null;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n'); buffer = blocks.pop();
    for (const block of blocks) {
      const line = block.split('\n').find((row) => row.startsWith('data: '));
      if (line) { try { last = JSON.parse(line.slice(6)).snapshot; } catch { /* malformed frame */ } }
    }
  }
  controller.abort();
  if (!last) return { venue, symbol, status: 'NOT VERIFIED', reason: 'no snapshot frame' };
  const ok = last.state === 'live' && last.verified === true && last.sequence.last != null;
  return {
    venue, symbol, status: ok ? 'PASS' : 'NOT VERIFIED',
    state: last.state, verified: last.verified, integrity: last.integrity,
    sequence: last.sequence.last, gaps: last.gaps, resyncs: last.resyncs,
    spreadBps: last.spreadBps, bidDepthUsd: last.bidDepthUsd,
    reason: ok ? null : 'book did not reach a verified live state in the probe window',
  };
}

const results = [];
for (const [venue, symbol] of venues) {
  try { results.push(await probe(venue, symbol)); }
  catch (error) { results.push({ venue, symbol, status: 'NOT VERIFIED', reason: error instanceof Error ? error.message : 'probe failed' }); }
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), base, seconds, results }, null, 2));
