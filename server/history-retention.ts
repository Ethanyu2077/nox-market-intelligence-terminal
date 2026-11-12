import { storageLimit, storageReserveBytes } from './storage-limits.ts';
import type { JournalSegment } from './journal-archive.ts';

const DAY = 86_400_000;
export type StoredJournal = JournalSegment & {dbKey: string};
export function historyLimits() {
  const maxBytes = storageLimit('NOX_JOURNAL_MAX_BYTES', 2 * 1024 ** 3);
  return {
    maxBytes,
    ackCacheBytes: Math.min(maxBytes, storageLimit('NOX_JOURNAL_ACK_CACHE_BYTES', 256 * 1024 ** 2)),
    days: storageLimit('NOX_JOURNAL_RETENTION_DAYS', 45),
    reserveBytes: storageReserveBytes(),
  };
}

export function journalsToRetire(files: StoredJournal[], reclaimable: (file: StoredJournal) => boolean,
  limits: ReturnType<typeof historyLimits>, freeBytes: number, incoming: number, now: number, replicated: boolean) {
  let stored = files.reduce((sum, file) => sum + file.storedBytes, 0);
  const today = Math.floor(now / DAY) * DAY;
  // The writer queue and exclusive reader lock cover the whole list-to-unlink operation.
  // A fully committed open file can be retired even if its feed never appends again.
  const ordered = files.map(file => {
    // Legacy single files have no partition date. Their mtime is the only safe age estimate.
    const day = Date.parse(file.name.slice(0, 10));
    const end = Number.isFinite(day) ? day + DAY : file.mtimeMs;
    return {file, end, expired: Math.max(end, file.mtimeMs) <= now - limits.days * DAY};
  }).filter(({file, end}) => (replicated || end <= today || (end <= today + DAY && file.key !== file.name)) && reclaimable(file))
    .sort((a, b) => Number(b.expired) - Number(a.expired) || a.end - b.end ||
      Number(a.file.key === a.file.name) - Number(b.file.key === b.file.name) ||
      (a.file.key === a.file.name && b.file.key === b.file.name ? a.file.mtimeMs - b.file.mtimeMs : 0) ||
      a.file.key.slice(-36, -23).localeCompare(b.file.key.slice(-36, -23)) ||
      (a.file.birth ?? 0) - (b.file.birth ?? 0) || a.file.key.localeCompare(b.file.key));
  let cached = replicated ? ordered.reduce((sum, {file}) => sum + file.storedBytes, 0) : 0;
  const target = replicated && cached > limits.ackCacheBytes ? Math.floor(limits.ackCacheBytes * .8) : Infinity;
  const retired: StoredJournal[] = [];
  for (const {file, expired} of ordered) {
    if (!expired && cached <= target && stored + incoming <= limits.maxBytes && freeBytes - incoming >= limits.reserveBytes) break;
    retired.push(file);
    cached -= file.storedBytes;
    stored -= file.storedBytes;
    freeBytes += file.storedBytes;
  }
  return retired;
}

/** Readers may overlap; only unlink needs an exclusive turn. The history writer serializes exclusive calls. */
export class JournalReaders {
  private count = 0;
  private writer?: Promise<void>;
  private drained?: () => void;

  async read<T>(work: () => Promise<T>) {
    while (this.writer) await this.writer;
    this.count++;
    try { return await work(); }
    finally { if (--this.count === 0) this.drained?.(); }
  }

  async exclusive<T>(work: () => Promise<T>) {
    let release!: () => void;
    this.writer = new Promise<void>(resolve => { release = resolve; });
    try {
      if (this.count) await new Promise<void>(resolve => { this.drained = resolve; });
      return await work();
    } finally {
      this.drained = undefined;
      this.writer = undefined;
      release();
    }
  }
}
