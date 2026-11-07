import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain ESM module used by the acceptance scripts
import { analyzeL2Frames, evaluateL2, buildL2Report } from '../scripts/acceptance/lib/l2-analysis.mjs';

const snap = (over: Record<string, unknown> = {}) => ({
  state: 'live', verified: true, integrity: 'ok', epoch: 1, sequence: { last: 10 }, gaps: 0, resyncs: 0,
  spreadBps: 0.5, bidDepthUsd: 1000, askDepthUsd: 1200, lastMessageAt: 0, ...over,
});
const frame = (at: number, over: Record<string, unknown> = {}, seq = 10) => ({ at, snapshot: snap({ ...over, sequence: { last: seq } }) });

test('continuous live window passes with full coverage', () => {
  const frames = [0, 1000, 2000, 3000, 4000].map((at, index) => frame(at, {}, 10 + index));
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 4000, requestedMs: 4000 });
  assert.equal(metrics.longestContinuousLiveMs, 4000);
  assert.equal(metrics.totalValidLiveMs, 4000);
  assert.equal(metrics.validWindowPct, 100);
  assert.equal(metrics.sequenceAdvanceCount, 4);
  assert.equal(evaluateL2(metrics, { requestedMs: 4000 }).status, 'PASS');
});

test('repeated heartbeat snapshots are not updates or advances', () => {
  const metrics = analyzeL2Frames([frame(0), frame(250), frame(500)], { windowStart: 0, windowEnd: 500, requestedMs: 500 });
  assert.equal(metrics.updatedFrames, 1);
  assert.ok(metrics.duplicates >= 2);
  assert.equal(metrics.sequenceAdvanceCount, 0);
  assert.equal(metrics.longestContinuousLiveMs, 0);
});

test('an interruption splits the run and reduces coverage against the full window', () => {
  const frames = [frame(0, {}, 10), frame(1000, {}, 11), frame(2000, {}, 12), frame(8000, {}, 13), frame(9000, {}, 14)];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 9000, requestedMs: 9000 });
  assert.equal(metrics.longestContinuousLiveMs, 2000, 'segments are never summed');
  assert.equal(metrics.totalValidLiveMs, 3000);
  assert.equal(metrics.maxUpdateGapMs, 6000);
  assert.ok(metrics.validWindowPct < 100);
});

test('live -> stale -> live breaks continuity', () => {
  const frames = [frame(0), frame(1000, { state: 'stale', verified: false }), frame(2000, {}, 12), frame(3000, {}, 13)];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 3000, requestedMs: 3000 });
  assert.equal(metrics.stateCounts.stale, 1);
  assert.equal(metrics.longestContinuousLiveMs, 1000);
  assert.ok(metrics.invalidStateDurationMs >= 2000);
  assert.equal(metrics.recoveryCompleted, true);
});

test('resyncing back to live without a new epoch is not a verified recovery', () => {
  const frames = [frame(0), frame(1000, { state: 'resyncing' }), frame(2000, {}, 12), frame(3000, {}, 13)];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 3000, requestedMs: 3000 });
  assert.equal(metrics.stateCounts.resyncing, 1);
  assert.equal(metrics.longestContinuousLiveMs, 0);
  assert.equal(metrics.gapDetected, true);
  assert.equal(metrics.gapRecovered, false, 'same-epoch live is not auditably recovered');
  assert.equal(metrics.recoveryCompleted, false);
  assert.equal(evaluateL2(metrics, { requestedMs: 3000 }).status, 'FAIL');
});

test('checksum failure without recovery fails the evaluation', () => {
  const frames = [frame(0), frame(1000, { integrity: 'checksum-failed', verified: false })];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 1000, requestedMs: 1000 });
  assert.equal(metrics.stateCounts.checksumFailed, 1);
  assert.equal(metrics.finalVerified, false);
  assert.equal(evaluateL2(metrics, { requestedMs: 1000 }).status, 'FAIL');
});

test('epoch change breaks the run and is counted', () => {
  const frames = [frame(0, { epoch: 1 }, 10), frame(1000, { epoch: 2 }, 4), frame(2000, { epoch: 2 }, 5)];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 2000, requestedMs: 2000 });
  assert.equal(metrics.epochChanges, 1);
  assert.equal(metrics.longestContinuousLiveMs, 1000);
  assert.equal(metrics.sequenceAdvanceCount, 1);
});

test('coverage uses the requested window, not the valid span', () => {
  const frames = [frame(0), frame(1000, {}, 11), frame(2000, {}, 12), frame(3000, {}, 13), frame(4000, {}, 14)];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 10_000, requestedMs: 10_000 });
  assert.equal(metrics.validWindowPct, 40);
  assert.equal(evaluateL2(metrics, { requestedMs: 10_000 }).status, 'FAIL');
});

test('a sequence gap breaks live continuity even when the next frame is live', () => {
  const frames = [frame(0, { gaps: 0 }, 10), frame(1000, { gaps: 1 }, 11), frame(2000, { gaps: 1 }, 12), frame(3000, { gaps: 1 }, 13)];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 3000, requestedMs: 3000 });
  assert.equal(metrics.gapDetected, true);
  assert.equal(metrics.gapRecovered, false, 'a live frame in the same epoch is not recovery');
  assert.equal(metrics.longestContinuousLiveMs, 0);
  assert.equal(evaluateL2(metrics, { requestedMs: 3000 }).status, 'FAIL');
});

test('gap recovery requires a new epoch and continuous updates after it', () => {
  const frames = [
    frame(0, { epoch: 1, gaps: 0 }, 10),
    frame(1000, { epoch: 1, gaps: 1, state: 'resyncing', verified: false }, 11),
    frame(2000, { epoch: 2, gaps: 0 }, 1),
    frame(3000, { epoch: 2, gaps: 0 }, 2),
    frame(4000, { epoch: 2, gaps: 0 }, 3),
  ];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 4000, requestedMs: 4000 });
  assert.equal(metrics.gapDetected, true);
  assert.equal(metrics.resyncStarted, true);
  assert.equal(metrics.gapRecovered, true);
  assert.equal(metrics.resyncCompleted, true);
  assert.equal(metrics.epochChanges, 1);
  assert.ok(metrics.longestContinuousLiveMs >= 2000);
});

test('checksum failure recovered by a new epoch is recorded', () => {
  const frames = [
    frame(0, { epoch: 1 }, 10),
    frame(1000, { epoch: 1, integrity: 'checksum-failed', verified: false }, 11),
    frame(2000, { epoch: 2 }, 1),
    frame(3000, { epoch: 2 }, 2),
  ];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 3000, requestedMs: 3000 });
  assert.equal(metrics.stateCounts.checksumFailed, 1);
  assert.equal(metrics.epochChanges, 1);
  assert.equal(metrics.finalIntegrity, 'ok');
});

test('report recovery fields and PASS/FAIL come from one decision', () => {
  const frames = [frame(0, { gaps: 0 }, 10), frame(1000, { gaps: 1 }, 11), frame(2000, { gaps: 1 }, 12)];
  const metrics = analyzeL2Frames(frames, { windowStart: 0, windowEnd: 2000, requestedMs: 2000 });
  const decision = evaluateL2(metrics, { requestedMs: 2000 });
  const report = buildL2Report('bybit', 'BTCUSDT', metrics, decision);
  assert.equal(report.recoveryCompleted, metrics.recoveryCompleted);
  assert.equal(report.recoveryCompleted, false);
  assert.equal(report.gapDetected, true);
  assert.equal(report.gapRecovered, false);
  assert.equal(report.status, 'FAIL');
  assert.ok(report.reasons.some((reason: string) => /gap/.test(reason)));
});
