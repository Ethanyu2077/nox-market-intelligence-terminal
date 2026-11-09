import { readFile, rename, writeFile } from 'node:fs/promises';

/** Target identity must be confirmed by content, not by a "test" substring in the name. */
export function evaluateTarget({ target, expectedDb, actualDb, productionAck }) {
  if (target !== 'test' && target !== 'production') return { ok: false, reason: '--target=test|production is required' };
  if (!expectedDb) return { ok: false, reason: 'MIGRATION_EXPECTED_DB is required' };
  if (!actualDb) return { ok: false, reason: 'cannot confirm the connected database identity' };
  if (actualDb !== expectedDb) return { ok: false, reason: 'connected database does not match MIGRATION_EXPECTED_DB' };
  if (target === 'production' && productionAck !== actualDb) return { ok: false, reason: 'production migration requires MIGRATION_PRODUCTION_ACK=<database name>' };
  return { ok: true, reason: null };
}

export function reconcileIds(expectedIds, foundIds) {
  const found = new Set(foundIds);
  const missing = expectedIds.filter((id) => !found.has(id));
  return { checked: expectedIds.length, missing: missing.length, missingSample: missing.slice(0, 5), ok: missing.length === 0 };
}

export async function readCheckpoint(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** Atomic replacement so a crash cannot leave a half-written checkpoint. */
export async function writeCheckpointAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
