import { createHash } from 'node:crypto';

export function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

/** Pure inspection of NDJSON journal lines; never writes or truncates. */
export function inspectJournal(lines, expectedKind = null) {
  let records = 0, malformed = 0, duplicates = 0, minEventTime = null, maxEventTime = null;
  const seen = new Set();
  const byKind = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { const parsed = JSON.parse(line); event = parsed.event ?? parsed; } catch { malformed += 1; continue; }
    if (!event || typeof event.id !== 'string' || !Number.isFinite(event.eventTime) || !Number.isFinite(event.ingestTime)) { malformed += 1; continue; }
    if (expectedKind && event.kind !== expectedKind) continue;
    records += 1;
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    const key = `${event.eventTime}:${event.id}`;
    if (seen.has(key)) duplicates += 1; else seen.add(key);
    minEventTime = minEventTime == null ? event.eventTime : Math.min(minEventTime, event.eventTime);
    maxEventTime = maxEventTime == null ? event.eventTime : Math.max(maxEventTime, event.eventTime);
  }
  return { records, malformed, duplicates, byKind, minEventTime, maxEventTime, uniqueIds: seen.size };
}

/** Checkpoints bind a file offset to the file hash, so modified journals are rejected. */
export function checkpointFor(previous, file, sha, offset, records) {
  return { version: 1, file, sha256: sha, offset, records, updatedAt: Date.now(), previous: previous?.updatedAt ?? null };
}

export function canResume(checkpoint, file, sha) {
  return Boolean(checkpoint && checkpoint.file === file && checkpoint.sha256 === sha && Number.isFinite(checkpoint.offset));
}
