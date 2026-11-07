/**
 * L2 state-timeline analysis over ALL raw SSE frames.
 *
 * Continuous live time is derived from intervals between consecutive frames whose states
 * are both valid live within the same epoch and within MAX_UPDATE_GAP_MS. Any stale,
 * resyncing, checksum-failed, gap or epoch transition breaks the run. The coverage
 * denominator is the full observation window, never the span of valid frames only.
 * Repeated snapshots (heartbeat / unchanged sequence) are not updates or advances.
 */
export const MAX_UPDATE_GAP_MS = 5_000;

function isLive(frame) {
  const s = frame?.snapshot;
  return Boolean(s && s.state === 'live' && s.verified === true && s.integrity === 'ok' && s.sequence && s.sequence.last != null);
}

export function analyzeL2Frames(frames, options = {}) {
  const ordered = [...(frames ?? [])].filter((frame) => frame?.at != null).sort((a, b) => a.at - b.at);
  const requestedMs = options.requestedMs ?? 0;
  const windowStart = options.windowStart ?? ordered[0]?.at ?? 0;
  const windowEnd = options.windowEnd ?? ordered.at(-1)?.at ?? windowStart;
  const windowMs = Math.max(0, windowEnd - windowStart);

  let totalValidLiveMs = 0;
  let longestContinuousLiveMs = 0;
  let currentRun = 0;
  let maxUpdateGapMs = 0;
  let invalidIntervals = 0;
  let lastInvalidAt = null;
  const counts = { stale: 0, resyncing: 0, checksumFailed: 0, gap: 0, unavailable: 0, unknown: 0 };

  const updates = [];
  const seen = new Set();
  let duplicates = 0;
  let lastUpdateAt = null;
  let previousGaps = null;
  let lastEpoch = null;

  // Leading window before the first frame is invalid, not live.
  let previous = null;
  let previousIsUpdate = false;
  for (const frame of ordered) {
    const s = frame.snapshot ?? {};
    const gapSinceUpdate = lastUpdateAt == null ? null : frame.at - lastUpdateAt;

    let isUpdate = false;
    if (isLive(frame)) {
      const key = `${s.epoch ?? 0}:${s.sequence.last}`;
      if (seen.has(key)) { duplicates += 1; }
      else {
        isUpdate = true;
        seen.add(key);
        updates.push(frame);
        if (lastUpdateAt != null) maxUpdateGapMs = Math.max(maxUpdateGapMs, frame.at - lastUpdateAt);
        lastUpdateAt = frame.at;
      }
      if (previousGaps != null && s.gaps > previousGaps) counts.gap += 1;
      previousGaps = s.gaps;
    } else {
      if (s.state === 'stale') counts.stale += 1;
      else if (s.state === 'resyncing') counts.resyncing += 1;
      else if (s.integrity === 'checksum-failed' || s.state === 'checksum-failed') counts.checksumFailed += 1;
      else if (s.state === 'unavailable') counts.unavailable += 1;
      else counts.unknown += 1;
      previousGaps = null;
    }

    if ((s.epoch ?? 0) !== (lastEpoch ?? s.epoch ?? 0) && lastEpoch != null) counts.epochChanges = (counts.epochChanges ?? 0) + 1;
    lastEpoch = s.epoch ?? lastEpoch;

    if (previous != null) {
      const interval = frame.at - previous.at;
      const continuous = previousIsUpdate && isUpdate && (previous.snapshot.epoch ?? 0) === (s.epoch ?? 0) && interval <= MAX_UPDATE_GAP_MS;
      if (continuous) {
        totalValidLiveMs += interval;
        currentRun += interval;
        longestContinuousLiveMs = Math.max(longestContinuousLiveMs, currentRun);
      } else {
        invalidIntervals += 1;
        lastInvalidAt = frame.at;
        currentRun = 0;
      }
      if (gapSinceUpdate != null) maxUpdateGapMs = Math.max(maxUpdateGapMs, gapSinceUpdate);
    }
    previous = frame;
    previousIsUpdate = isUpdate;
  }

  // Tail after the last frame is invalid.
  if (ordered.length && windowEnd > ordered.at(-1).at) { invalidIntervals += 1; lastInvalidAt = windowEnd; }
  if (windowStart < (ordered[0]?.at ?? windowStart)) invalidIntervals += 1;

  const invalidStateDurationMs = Math.max(0, windowMs - totalValidLiveMs);
  const validWindowPct = windowMs > 0 ? Math.min(100, totalValidLiveMs / windowMs * 100) : 0;
  const last = ordered.at(-1)?.snapshot ?? null;
  const resyncsDelta = updates.length > 1 ? (last?.resyncs ?? 0) - (updates[0].snapshot.resyncs ?? 0) : 0;
  const gapsDelta = updates.length > 1 ? (last?.gaps ?? 0) - (updates[0].snapshot.gaps ?? 0) : 0;
  const epochs = [...new Set(ordered.map((frame) => frame.snapshot?.epoch).filter((value) => value != null))];
  const advances = updates.filter((frame, index) => index > 0 && (frame.snapshot.epoch ?? 0) === (updates[index - 1].snapshot.epoch ?? 0) && frame.snapshot.sequence.last > updates[index - 1].snapshot.sequence.last).length;

  // Recovery = after the last invalid interval there is a new live run of >=2 updates.
  const recoveryStart = lastInvalidAt ?? windowStart;
  const afterRecovery = updates.filter((frame) => frame.at >= recoveryStart);
  const recoveryCompleted = lastInvalidAt == null ? isLive({ snapshot: last }) : afterRecovery.length >= 2 && isLive({ snapshot: last });

  return {
    frames: ordered.length,
    updatedFrames: updates.length,
    duplicates,
    heartbeatOnlyFrames: ordered.filter((frame) => isLive(frame) && seen.has(`${frame.snapshot.epoch ?? 0}:${frame.snapshot.sequence.last}`)).length - updates.length >= 0 ? duplicates : duplicates,
    sequenceAdvanceCount: advances,
    epochChanges: counts.epochChanges ?? 0,
    epochs,
    longestContinuousLiveMs,
    totalValidLiveMs,
    validWindowPct: Number(validWindowPct.toFixed(2)),
    maxUpdateGapMs,
    invalidStateDurationMs,
    windowStart,
    windowEnd,
    requestedDurationMs: requestedMs,
    observedDurationMs: windowMs,
    gapsDelta,
    resyncsDelta,
    stateCounts: { stale: counts.stale, resyncing: counts.resyncing, checksumFailed: counts.checksumFailed, gap: counts.gap, unavailable: counts.unavailable, unknown: counts.unknown },
    invalidIntervals,
    recoveryCompleted,
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

/** PASS decision with explicit reasons; never infers continuity from a final frame. */
export function evaluateL2(metrics, thresholds = {}) {
  const requested = thresholds.requestedMs ?? metrics.requestedDurationMs ?? 0;
  const minCoverage = thresholds.minCoveragePct ?? 80;
  const minRunPct = thresholds.minRunPct ?? 80;
  const maxGap = thresholds.maxGapMs ?? MAX_UPDATE_GAP_MS;
  const reasons = [];
  if (metrics.observedDurationMs < requested * 0.8) reasons.push('observed window below 80% of requested');
  if (metrics.validWindowPct < minCoverage) reasons.push('valid live coverage below threshold');
  if (metrics.longestContinuousLiveMs < requested * minRunPct / 100) reasons.push('longest continuous live run below threshold');
  if (metrics.maxUpdateGapMs > maxGap) reasons.push('update gap above limit');
  if (metrics.sequenceAdvanceCount < 1) reasons.push('sequence did not advance');
  if (metrics.gapsDelta > 0) reasons.push('unrecovered sequence gap');
  if ((metrics.stateCounts?.checksumFailed ?? 0) > 0 && !metrics.recoveryCompleted) reasons.push('unrecovered checksum failure');
  if (!((metrics.spreadBps ?? 0) > 0)) reasons.push('invalid spread');
  if (!((metrics.bidDepthUsd ?? 0) > 0) || !((metrics.askDepthUsd ?? 0) > 0)) reasons.push('invalid depth');
  if (metrics.finalState !== 'live' || metrics.finalVerified !== true) reasons.push('final book not verified live');
  if (!metrics.recoveryCompleted) reasons.push('no continuous recovery after interruption');
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons };
}
