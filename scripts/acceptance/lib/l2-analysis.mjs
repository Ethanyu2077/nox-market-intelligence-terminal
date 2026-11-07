/**
 * Deterministic L2 continuity analysis over SSE frames.
 * Frames are { at, snapshot }. Repeated snapshots (SSE heartbeat / unchanged book) are
 * deduplicated by epoch+sequence and never counted as updates, advances or live time.
 */
export const MAX_UPDATE_GAP_MS = 5_000;

export function analyzeL2Frames(frames, options = {}) {
  const requestedMs = options.requestedMs ?? 0;
  const valid = (frames ?? []).filter((frame) => {
    const s = frame?.snapshot;
    return s && s.state === 'live' && s.verified === true && s.integrity === 'ok' && s.sequence && s.sequence.last != null;
  });
  const observedDurationMs = valid.length ? valid.at(-1).at - valid[0].at : 0;

  const updates = [];
  const seen = new Set();
  let duplicates = 0;
  for (const frame of valid) {
    const key = `${frame.snapshot.epoch ?? 0}:${frame.snapshot.sequence.last}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    updates.push(frame);
  }

  let advances = 0;
  let epochChanges = 0;
  let maxUpdateGapMs = 0;
  for (let index = 1; index < updates.length; index += 1) {
    const previous = updates[index - 1].snapshot;
    const current = updates[index].snapshot;
    const gap = updates[index].at - updates[index - 1].at;
    maxUpdateGapMs = Math.max(maxUpdateGapMs, gap);
    if ((current.epoch ?? 0) !== (previous.epoch ?? 0)) { epochChanges += 1; continue; }
    if (current.sequence.last > previous.sequence.last) advances += 1;
  }

  // Longest single uninterrupted live run, never a sum of separate runs.
  let longestContinuousLiveMs = 0;
  let totalValidLiveMs = 0;
  let runStart = updates[0]?.at ?? null;
  let runEnd = runStart;
  for (let index = 1; index < updates.length; index += 1) {
    const gap = updates[index].at - updates[index - 1].at;
    if (gap <= MAX_UPDATE_GAP_MS && (updates[index].snapshot.epoch ?? 0) === (updates[index - 1].snapshot.epoch ?? 0)) {
      totalValidLiveMs += gap;
      runEnd = updates[index].at;
    } else {
      if (runStart != null && runEnd != null) longestContinuousLiveMs = Math.max(longestContinuousLiveMs, runEnd - runStart);
      runStart = updates[index].at;
      runEnd = runStart;
    }
  }
  if (runStart != null && runEnd != null) longestContinuousLiveMs = Math.max(longestContinuousLiveMs, runEnd - runStart);

  const invalidStateDurationMs = Math.max(0, observedDurationMs - totalValidLiveMs);
  const validWindowPct = observedDurationMs > 0 ? Math.min(100, totalValidLiveMs / observedDurationMs * 100) : 0;
  const firstSeq = updates[0]?.snapshot.gaps ?? 0;
  const last = updates.at(-1)?.snapshot;
  const gapsDelta = last ? last.gaps - firstSeq : 0;
  const resyncsDelta = last && updates[0] ? last.resyncs - updates[0].snapshot.resyncs : 0;

  return {
    updatedFrames: updates.length,
    duplicates,
    sequenceAdvanceCount: advances,
    epochChanges,
    longestContinuousLiveMs,
    totalValidLiveMs,
    validWindowPct: Number(validWindowPct.toFixed(2)),
    maxUpdateGapMs,
    invalidStateDurationMs,
    observedDurationMs,
    requestedDurationMs: requestedMs,
    gapsDelta,
    resyncsDelta,
    finalState: last?.state ?? null,
    finalVerified: last?.verified ?? null,
    finalEpoch: last?.epoch ?? null,
    finalSequence: last?.sequence?.last ?? null,
    spreadBps: last?.spreadBps ?? null,
    bidDepthUsd: last?.bidDepthUsd ?? null,
    askDepthUsd: last?.askDepthUsd ?? null,
    finalMessageAt: last?.lastMessageAt ?? null,
  };
}
