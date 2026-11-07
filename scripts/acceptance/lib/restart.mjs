/**
 * Pure decision for process-restart recovery. Reconnecting a pool is NOT a restart, and a
 * successful restart command alone is NOT proof: identity must change, the API must be
 * ready again, and records must be read back through the API without loss or duplication.
 */
export function evaluateRestart(input) {
  const {
    restartAuthorized, restartOk, identityBefore, identityAfter,
    readyAfter, apiReadAvailable, idsBefore = [], idsAfter = [],
  } = input;
  if (!restartAuthorized) return { status: 'NOT VERIFIED', reason: 'restart is not explicitly authorized' };
  if (!restartOk) return { status: 'FAIL', reason: 'restart command failed' };
  if (!identityBefore || !identityAfter) return { status: 'NOT VERIFIED', reason: 'process identity is unavailable' };
  if (identityBefore === identityAfter) return { status: 'FAIL', reason: 'process identity did not change (no restart)' };
  if (!readyAfter) return { status: 'FAIL', reason: 'API did not become ready after restart' };
  if (!apiReadAvailable) return { status: 'NOT VERIFIED', reason: 'records could not be read through the restarted API' };
  if (idsAfter.length !== new Set(idsAfter).size) return { status: 'FAIL', reason: 'duplicate records after restart' };
  const before = [...idsBefore].sort().join(',');
  const after = [...idsAfter].sort().join(',');
  if (before !== after) return { status: 'FAIL', reason: 'records missing or changed after restart' };
  return { status: 'PASS', reason: null };
}
