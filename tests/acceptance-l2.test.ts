import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain ESM module used by the acceptance scripts
import { analyzeL2Frames } from '../scripts/acceptance/lib/l2-analysis.mjs';

const snapshot = (over: Record<string, unknown> = {}) => ({
  state: 'live', verified: true, integrity: 'ok', epoch: 1, sequence: { last: 10 }, gaps: 0, resyncs: 0,
  spreadBps: 0.5, bidDepthUsd: 1000, askDepthUsd: 1200, lastMessageAt: 0, ...over,
});
const frames = (times: number[], over: Record<string, unknown> = {}, start = 10) => times.map((at, index) => ({ at, snapshot: snapshot({ ...over, sequence: { last: start + index } }) }));

test('continuous updates: longest run equals the whole window and advances count', () => {
  const result = analyzeL2Frames(frames([0, 1000, 2000, 3000, 4000]), { requestedMs: 5000 });
  assert.equal(result.sequenceAdvanceCount, 4);
  assert.equal(result.longestContinuousLiveMs, 4000);
  assert.equal(result.totalValidLiveMs, 4000);
  assert.equal(result.maxUpdateGapMs, 1000);
  assert.equal(result.duplicates, 0);
});

test('repeated snapshots and heartbeats are not updates or advances', () => {
  const framesInput = [
    { at: 0, snapshot: snapshot({ sequence: { last: 10 } }) },
    { at: 250, snapshot: snapshot({ sequence: { last: 10 } }) },
    { at: 500, snapshot: snapshot({ sequence: { last: 10 } }) },
  ];
  const result = analyzeL2Frames(framesInput, { requestedMs: 5000 });
  assert.equal(result.updatedFrames, 1);
  assert.equal(result.duplicates, 2);
  assert.equal(result.sequenceAdvanceCount, 0);
  assert.equal(result.longestContinuousLiveMs, 0);
});

test('an interruption splits the run: longest is not the sum of segments', () => {
  const input = [...frames([0, 1000, 2000]), ...frames([8000, 9000, 10_000], {}, 20)];
  const result = analyzeL2Frames(input, { requestedMs: 10_000 });
  assert.equal(result.longestContinuousLiveMs, 2000, 'separate runs are never summed into the longest');
  assert.equal(result.totalValidLiveMs, 4000);
  assert.equal(result.maxUpdateGapMs, 6000);
});

test('stale or unverified snapshots do not count as live time', () => {
  const input = [
    { at: 0, snapshot: snapshot({ state: 'stale' }) },
    { at: 1000, snapshot: snapshot({ verified: false }) },
    { at: 2000, snapshot: snapshot({ sequence: { last: 12 } }) },
    { at: 3000, snapshot: snapshot({ sequence: { last: 13 } }) },
  ];
  const result = analyzeL2Frames(input, { requestedMs: 5000 });
  assert.equal(result.updatedFrames, 2);
  assert.equal(result.longestContinuousLiveMs, 1000);
});

test('epoch change is recorded and does not count as a sequence advance', () => {
  const input = [
    { at: 0, snapshot: snapshot({ epoch: 1, sequence: { last: 10 } }) },
    { at: 1000, snapshot: snapshot({ epoch: 2, sequence: { last: 4 } }) },
    { at: 2000, snapshot: snapshot({ epoch: 2, sequence: { last: 5 } }) },
  ];
  const result = analyzeL2Frames(input, { requestedMs: 5000 });
  assert.equal(result.epochChanges, 1);
  assert.equal(result.sequenceAdvanceCount, 1);
  assert.equal(result.longestContinuousLiveMs, 1000);
});
