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
const { analyzeL2Frames } = await import('./lib/l2-analysis.mjs');

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
    let endedEarly = false;
    while (Date.now() - started < seconds * 1000) {
      if (Date.now() - lastData > 8_000) return { venue, symbol, status: 'NOT VERIFIED', reason: 'no data within 8s', frames: frames.length };
      const read = await withTimeout(reader.read(), 3_000, 'read').catch(() => ({ done: true }));
      if (read.done) { endedEarly = Date.now() - started < seconds * 1000; break; }
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split('\n\n'); buffer = blocks.pop();
      for (const block of blocks) {
        const line = block.split('\n').find((row) => row.startsWith('data: '));
        if (!line) continue;
        try { frames.push({ at: Date.now(), snapshot: JSON.parse(line.slice(6)).snapshot }); lastData = Date.now(); } catch { /* malformed */ }
      }
    }
    const metrics = analyzeL2Frames(frames, { requestedMs: seconds * 1000 });
    const delays = frames.map((frame) => frame.snapshot?.lastMessageAt ? frame.at - frame.snapshot.lastMessageAt : null).filter((value) => value != null && value >= 0);
    const maxDelay = delays.length ? Math.max(...delays) : null;
    const enoughTime = metrics.observedDurationMs >= seconds * 1000 * 0.8;
    const coverageOk = metrics.validWindowPct >= 80;
    const continuousOk = metrics.longestContinuousLiveMs >= seconds * 1000 * 0.8;
    const recoveryCompleted = metrics.finalState === 'live' && metrics.finalVerified === true;
    const healthy = metrics.updatedFrames >= 2
      && metrics.sequenceAdvanceCount >= 1
      && metrics.gapsDelta === 0
      && metrics.maxUpdateGapMs <= 5_000
      && enoughTime && coverageOk && continuousOk
      && (metrics.spreadBps ?? 0) > 0 && (metrics.bidDepthUsd ?? 0) > 0 && (metrics.askDepthUsd ?? 0) > 0
      && maxDelay != null && maxDelay <= 15_000
      && !endedEarly
      && (metrics.epochChanges === 0 || recoveryCompleted);
    const status = healthy ? 'PASS' : metrics.updatedFrames < 2 ? 'NOT VERIFIED' : 'FAIL';
    return {
      venue, symbol, status,
      requestedDurationMs: seconds * 1000, observedDurationMs: metrics.observedDurationMs,
      longestContinuousLiveMs: metrics.longestContinuousLiveMs, totalValidLiveMs: metrics.totalValidLiveMs,
      validWindowPct: metrics.validWindowPct, maxUpdateGapMs: metrics.maxUpdateGapMs,
      invalidStateDurationMs: metrics.invalidStateDurationMs,
      sequenceAdvanceCount: metrics.sequenceAdvanceCount, epochChanges: metrics.epochChanges,
      recoveryCompleted,
      framesReceived: frames.length, validUpdates: metrics.updatedFrames, duplicates: metrics.duplicates,
      gaps: metrics.finalSequence == null ? null : undefined, gapsDelta: metrics.gapsDelta,
      resyncsDelta: metrics.resyncsDelta,
      maxDelayMs: maxDelay, integrity: metrics.finalState, finalState: metrics.finalState,
      spreadBps: metrics.spreadBps, bidDepthUsd: metrics.bidDepthUsd, askDepthUsd: metrics.askDepthUsd,
      endedEarly,
      reason: healthy ? null : metrics.updatedFrames < 2 ? 'fewer than two valid live updates in the window'
        : endedEarly ? 'SSE ended before the requested window'
        : !continuousOk ? 'longest continuous live run below 80% of the window'
        : 'continuity criteria not met',
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
