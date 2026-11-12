import { open } from 'node:fs/promises';
import path from 'node:path';
export class IncompleteAppendTail extends Error {}

/** The history queue serializes appends and rotations for this single-writer partition. */
export async function appendJournalBatch(file: string, lines: string) {
  const handle = await open(file, 'a+', 0o600);
  try {
    const { size } = await handle.stat();
    if (size) {
      const tail = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(tail, 0, 1, size - 1);
      if (bytesRead !== 1 || tail[0] !== 10)
        throw new IncompleteAppendTail(`Incomplete journal tail in ${path.basename(file)}; recovery required`);
    }
    try {
      await handle.writeFile(lines);
    } catch (error) {
      // ENOSPC can follow a partial write, even after complete rows within the batch.
      try { await handle.truncate(size); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Journal append and rollback failed in ${path.basename(file)}`);
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}
