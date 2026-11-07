#!/usr/bin/env node
/**
 * L2 live acceptance probe V2.
 *
 * PASS requires continuity, not just a final `live` frame: at least two valid updates,
 * a strictly advancing sequence inside one book epoch, positive spread/depth, no new gap,
 * and a bounded message delay for the whole window.
 *
 *   node scripts/acceptance/l2-live.mjs [apiBase] [seconds]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const seconds = Math.max(5, Number(process.argv[3] ?? 20));
const venues = [['binance', 'BTCUSDT'], ['bybit', 'BTCUSDT'], ['okx', 'BTC-USDT-SWAP']];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

async function probe(venue, symbol) {
  const overall = new AbortController();
  const timer = setTimeout(() => overall.abort(), (seconds + 10) * 1000);
  const started = Date.now();
  const frames = [];
  try {
    const response = await withTimeout(fetch(`${base}/api/market/${venue}/${symbol}/book/stream`, { signal: overall.signal }), 8_000, 'connect');
    if (!response.ok) return { venue, symbol, status: 'NOT VERIFIED', reason: `HTTP ${response.status}` };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastData = Date.now();
    while (Date.now() - started < seconds * 1000) {
      if (Date.now() - lastData > 8_000) return { venue, symbol, status: 'NOT VERIFIED', reason: 'no data within 8s', frames: frames.length };
      const read = await withTimeout(reader.read(), 3_000, 'read').catch(() => ({ done: true }));
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split('\n\n'); buffer = blocks.pop();
      for (const block of blocks) {
        const line = block.split('\n').find((row) => row.startsWith('data: '));
        if (!line) continue;
        try { frames.push({ at: Date.now(), snapshot: JSON.parse(line.slice(6)).snapshot }); lastData = Date.now(); } catch { /* malformed */ }
      }
    }
    const valid = frames.filter((frame) => frame.snapshot?.state === 'live' && frame.snapshot?.verified === true && frame.snapshot?.sequence.last != null);
    const epochs = [...new Set(valid.map((frame) => frame.snapshot.epoch))];
    const sequences = valid.map((frame) => frame.snapshot.sequence.last);
    let advances = 0;
    for (let index = 1; index < sequences.length; index += 1) if (sequences[index] > sequences[index - 1]) advances += 1;
    const first = valid[0]?.snapshot, last = valid.at(-1)?.snapshot;
    const gapsDelta = first && last ? last.gaps - first.gaps : 0;
    const resyncsDelta = first && last ? last.resyncs - first.resyncs : 0;
    const delays = frames.map((frame) => frame.snapshot?.lastMessageAt ? frame.at - frame.snapshot.lastMessageAt : null).filter((value) => value != null && value >= 0);
    const maxDelay = delays.length ? Math.max(...delays) : null;
    const healthy = valid.length >= 2
      && advances >= 1
      && epochs.length === 1
      && gapsDelta === 0
      && (last?.spreadBps ?? 0) > 0
      && (last?.bidDepthUsd ?? 0) > 0
      && (last?.askDepthUsd ?? 0) > 0
      && maxDelay != null && maxDelay <= 15_000;
    return {
      venue, symbol, status: healthy ? 'PASS' : 'FAIL', durationMs: Date.now() - started,
      framesReceived: frames.length, validUpdates: valid.length, sequenceAdvances: advances,
      epochs, gaps: last?.gaps ?? null, gapsDelta, resyncs: last?.resyncs ?? null, resyncsDelta,
      maxDelayMs: maxDelay, integrity: last?.integrity ?? null, finalState: last?.state ?? null,
      spreadBps: last?.spreadBps ?? null, bidDepthUsd: last?.bidDepthUsd ?? null, askDepthUsd: last?.askDepthUsd ?? null,
      reason: healthy ? null : 'continuity criteria not met',
    };
  } catch (error) {
    return { venue, symbol, status: 'NOT VERIFIED', reason: error instanceof Error ? error.message : 'probe failed', frames: frames.length };
  } finally {
    clearTimeout(timer);
    overall.abort();
  }
}

const results = [];
for (const [venue, symbol] of venues) results.push(await probe(venue, symbol));
const report = { generatedAt: new Date().toISOString(), base, seconds, results };
console.log(JSON.stringify(report, null, 2));
const failed = results.some((row) => row.status === 'FAIL');
process.exitCode = failed ? 1 : 0;
