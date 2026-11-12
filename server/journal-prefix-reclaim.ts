import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { StoredJournal } from './history-retention.ts';

const temporary = '.nox-journal-prefix.tmp';
const MAX_SUFFIX_BYTES = 16 * 1024 ** 2;
type SavedPrefix = { offset: number; identity: string; birth?: number };

/** A crash before rename leaves the complete original and only this disposable staging file. */
export function cleanupJournalPrefixTemp(directory: string) {
  return rm(path.join(directory, temporary), {force: true});
}

/** Caller holds the single writer queue and the exclusive journal read lock throughout. */
export async function reclaimJournalPrefix(
  file: StoredJournal, saved: SavedPrefix | undefined, scratchBytes: number, stillVerified: () => boolean,
): Promise<number> {
  // A raw file's checkpoint is tied to its inode and birth time. Sealed names encode their
  // original generation and must keep the same logical byte offsets across compression.
  if (file.key !== file.name || file.compressed || file.copies?.length || !saved ||
      saved.identity !== file.identity || !saved.birth || saved.birth !== file.birth ||
      !Number.isSafeInteger(saved.offset) || !Number.isSafeInteger(file.size) ||
      !Number.isFinite(scratchBytes) || !stillVerified()) return 0;
  const suffixBytes = file.size - saved.offset;
  if (suffixBytes <= 0 || suffixBytes >= saved.offset || suffixBytes > Math.min(scratchBytes, MAX_SUFFIX_BYTES)) return 0;

  const directory = path.dirname(file.file);
  const staging = path.join(directory, temporary);
  const source = await open(file.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let ownsStaging = false;
  try {
    const sameFile = (info: Stats) =>
      info.isFile() && info.nlink === 1 && info.size === file.size && info.mtimeMs === file.mtimeMs &&
      info.dev + ':' + info.ino === saved.identity && Math.round(info.birthtimeMs * 1000) === saved.birth;
    if (!sameFile(await source.stat())) return 0;
    const buffer = Buffer.allocUnsafe(Math.min(suffixBytes, 64 * 1024));
    if ((await source.read(buffer, 0, 1, saved.offset - 1)).bytesRead !== 1 || buffer[0] !== 10) return 0;

    const destination = await open(staging, 'wx', 0o600);
    ownsStaging = true;
    try {
      let pos = saved.offset;
      while (pos < file.size) {
        const {bytesRead} = await source.read(buffer, 0, Math.min(buffer.length, file.size - pos), pos);
        if (!bytesRead) throw new Error('Journal changed during prefix reclamation');
        await destination.writeFile(buffer.subarray(0, bytesRead));
        pos += bytesRead;
      }
      await destination.sync();
    } finally { await destination.close(); }

    if (!sameFile(await lstat(file.file)) || !stillVerified()) return 0;
    // A reader after a crash sees either the original or the exact suffix with a new inode.
    // The old checkpoint can never acknowledge the new file, even if rename reached disk
    // before a subsequent checkpoint write. No data-bearing file is unlinked beforehand.
    await rename(staging, file.file);
    ownsStaging = false;
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return saved.offset;
  } finally {
    try { if (ownsStaging) await rm(staging, {force: true}); }
    finally { await source.close(); }
  }
}
