import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { storageReserveBytes } from './storage-limits.ts';

const DAY = 86_400_000;
// The immutable name preserves the writer's original inode and logical byte offsets across compression.
const segment = /^(.+\.ndjson)\.(\d+)-(\d+)-((?:b\d+-)?[a-f0-9-]{36})\.(?:sealed|kept|(\d+)\.(x|-?\d+)\.(x|-?\d+)\.gz)$/;
let lastGenerationTime = 0;
function segmentId() {
  // Size-based rotation can seal multiple batches in the same millisecond.
  lastGenerationTime = Math.max(Date.now(), lastGenerationTime + 1);
  const time = lastGenerationTime.toString(16).padStart(12, '0');
  return time.slice(0, 8) + '-' + time.slice(8) + randomUUID().slice(13);
}
function sealedName(name: string, identity: string, birth: number) {
  return name + '.' + identity.replace(':', '-') + '-b' + birth + '-' + segmentId() + '.sealed';
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Called while the journal writer holds the append/rotate queue. */
export async function sealJournalForAppend(file: string, minBytes: number) {
  try {
    const info = await stat(file);
    if (!info.size || info.size < minBytes) return;
    const name = sealedName(path.basename(file), info.dev + ':' + info.ino, Math.round(info.birthtimeMs * 1000));
    await rename(file, path.join(path.dirname(file), name));
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export type JournalSegment = {
  file: string; name: string; key: string; identity: string; size: number; storedBytes: number;
  compressed: boolean; mtimeMs: number; birth?: number; minTime?: number; maxTime?: number;
  /** Additional physical copies left by an interruption between publication and unlink. */
  copies?: string[];
};

export async function journalSegments(dir: string, accepts: (name: string) => boolean): Promise<JournalSegment[]> {
  const list = async () => (await readdir(dir)).filter(file => accepts(segment.exec(file)?.[1] ?? file)).sort();
  const names = await list();
  const entries = new Map<string, JournalSegment>();
  for (const file of names) {
    const m = segment.exec(file);
    const name = m?.[1] ?? file;
    let info;
    try { info = await stat(path.join(dir, file)); }
    catch (e) {
      if (missing(e)) return journalSegments(dir, accepts);
      throw e;
    }
    const compressed = !!m?.[5];
    const key = m ? file.slice(0, file.indexOf(m[4]) + m[4].length) : name;
    const physical = info.size;
    const birth = m ? /^b(\d+)-/.exec(m[4]) : null;
    const item = {
      birth: m ? (birth ? Number(birth[1]) : undefined) : Math.round(info.birthtimeMs * 1000),
      file: path.join(dir, file), name, key, identity: m ? m[2] + ':' + m[3] : info.dev + ':' + info.ino,
      size: compressed ? Number(m![5]) : info.size, storedBytes: physical, compressed, mtimeMs: info.mtimeMs,
      minTime: compressed && m![6] !== 'x' ? Number(m![6]) : undefined,
      maxTime: compressed && m![7] !== 'x' ? Number(m![7]) : undefined,
    };
    // A process can stop between publish and unlink. A surviving sealed source is authoritative.
    const prior = entries.get(key);
    if (!prior) entries.set(key, item);
    else {
      const preferred = !prior.compressed || compressed && prior.size >= item.size ? prior : item;
      const extra = preferred === prior ? item.file : prior.file;
      entries.set(key, {...preferred, copies: [...(prior.copies ?? []), extra], storedBytes: prior.storedBytes + physical});
    }
  }
  // The raw path can be sealed AND recreated for a late append between readdir
  // and stat. In that case stat succeeds, but its archived predecessor must also be listed.
  const latest = await list();
  if (names.length !== latest.length || names.some((name, i) => name !== latest[i])) return journalSegments(dir, accepts);
  return [...entries.values()].sort((a,b) => a.name.localeCompare(b.name) || Number(a.key === a.name) - Number(b.key === b.name) || a.key.slice(-36).localeCompare(b.key.slice(-36)));
}

/** Open the listed inode even if it became an archive while the reader was waiting. */
export async function* journalBytes(listed: JournalSegment, start = 0): AsyncGenerator<Buffer> {
  if (start > listed.size) throw new Error('Journal truncated after checkpoint');
  if (start === listed.size) return;
  let item = listed;
  for (;;) {
    let handle;
    try { handle = await open(item.file, 'r'); }
    catch (e) { if (!missing(e)) throw e; }
    if (handle) {
      try {
        const info = await handle.stat();
        if (item.key !== item.name || (item.identity === info.dev + ':' + info.ino && item.birth === Math.round(info.birthtimeMs * 1000))) {
          if (!item.compressed && info.size < listed.size) throw new Error('Journal truncated during read');
          const raw = handle.createReadStream(item.compressed ? { autoClose: false } : { autoClose: false, start, end: listed.size - 1 });
          const stream = item.compressed ? raw.compose(createGunzip()) : raw;
          let skip = item.compressed ? start : 0, remaining = listed.size - start, decoded = 0;
          try {
            for await (const buffer of stream) {
              const chunk = buffer as Buffer;
              decoded += chunk.length;
              if (item.compressed && decoded > item.size) throw new Error('Invalid journal archive length');
              if (skip >= chunk.length) { skip -= chunk.length; continue; }
              const data = chunk.subarray(skip, skip + remaining);
              skip = 0;
              remaining -= data.length;
              if (data.length) yield data;
            }
            if (remaining || item.compressed && decoded !== item.size) throw new Error('Incomplete journal archive');
          } finally { stream.destroy(); raw.destroy(); }
          return;
        }
      } finally { await handle.close(); }
    }
    const replacement = (await journalSegments(path.dirname(item.file), name => name === item.name))
      .find(other => other.identity === item.identity && (other.birth === undefined || item.birth === undefined || other.birth === item.birth) && (item.key === item.name || other.key === item.key));
    if (!replacement || replacement.file === item.file) throw new Error('Journal identity changed during read');
    item = replacement;
  }
}

export function archiveByteBudget(size: number, freeBytes: number) {
  return Math.max(0, Math.min(size - 1, freeBytes - storageReserveBytes()));
}
class NoSavings extends Error {}
export class ArchiveSpaceError extends Error {}

async function compress(item: JournalSegment, indexTime: boolean, budget: number) {
  const dir = path.dirname(item.file), stem = path.basename(item.file, '.sealed');
  const temporary = path.join(dir, stem + '.' + randomUUID() + '.gz.tmp');
  let min = Infinity, max = -Infinity, valid = true;
  let tail: Buffer = Buffer.alloc(0);
  async function* inspect() {
    for await (const chunk of journalBytes(item)) {
      if (indexTime && valid) {
        const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        let from = 0, newline;
        while ((newline = bytes.indexOf(10, from)) >= 0) {
          try {
            const t = JSON.parse(bytes.toString('utf8', from, newline)).eventTime;
            if (!Number.isSafeInteger(t)) throw new Error();
            min = Math.min(min, t); max = Math.max(max, t);
          } catch { valid = false; break; }
          from = newline + 1;
        }
        // A malformed or unusually large line remains losslessly archived without a range index.
        if (bytes.length - from > 2 * 1024 * 1024) valid = false;
        tail = valid ? bytes.subarray(from) : Buffer.alloc(0);
      }
      yield chunk;
    }
  }
  try {
    let written = 0;
    async function* withinBudget(chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        written += chunk.length;
        if (written >= item.size) throw new NoSavings();
        if (written > budget) throw new ArchiveSpaceError('Insufficient space to compress journal while preserving live write reserve');
        yield chunk;
      }
    }
    await pipeline(inspect(), createGzip({level: 1}), withinBudget, createWriteStream(temporary, {flags: 'wx', mode: 0o600}));
    const after = await stat(item.file);
    if (after.size !== item.size || after.mtimeMs !== item.mtimeMs) return;
    const ranges = indexTime && valid && !tail.length && min <= max ? min + '.' + max : 'x.x';
    const target = path.join(dir, stem + '.' + item.size + '.' + ranges + '.gz');
    // Durably publish the replacement before releasing the only plain copy.
    const completed = await open(temporary, 'r');
    try { await completed.sync(); } finally { await completed.close(); }
    await rename(temporary, target);
    const directory = await open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    await rm(item.file);
  } catch (e) {
    if (!(e instanceof NoSavings)) throw e;
    // Keep a small/incompressible original in its immutable segment. Do not
    // recompress it every hour at the expense of other cold partitions.
    await rename(item.file, path.join(dir, stem + '.kept'));
  }
  finally { await rm(temporary, {force:true}); }
}

const archiving = new Map<string, Promise<void>>();
const archiveTemporary = /^(.+\.ndjson)\.\d+-\d+-(?:b\d+-)?[a-f0-9-]{36}\.[a-f0-9-]{36}\.gz\.tmp$/;

/** On single-writer startup, a previous process's unpublished gzip has a surviving source. */
export async function cleanupAbandonedArchiveTemps(dir: string, accepts: (name: string) => boolean) {
  if (archiving.has(dir)) return;
  for (const name of await readdir(dir)) {
    const match = archiveTemporary.exec(name);
    if (match && accepts(match[1])) await rm(path.join(dir, name), { force: true });
  }
}

// History and outcomes may occupy the same volume. Stage only one replacement at a time.
let archiveQueue = Promise.resolve();
export function archiveClosedJournals(
  dir: string, accepts: (name: string) => boolean,
  options: {
    indexTime?: boolean;
    rotate?: (work: () => Promise<void>) => Promise<void>;
    reserve?: (requested: number, item: JournalSegment) => Promise<{ bytes: number; release(): void }>;
  } = {},
) {
  const previous = archiving.get(dir);
  if (previous) return previous;
  const work = archiveQueue.then(async () => {
    const cutoff = Date.now() - 2 * DAY;
    // A terminated process may leave an unpublished temporary gzip. Its sealed
    // source still exists. Preserve all other files, including live work in progress.
    for (const name of await readdir(dir)) {
      const m = archiveTemporary.exec(name);
      if (!m || !accepts(m[1])) continue;
      const temporary = path.join(dir, name);
      try { if ((await stat(temporary)).mtimeMs < cutoff) await rm(temporary, {force:true}); }
      catch (e) { if (!missing(e)) throw e; }
    }
    let remaining = 4;
    for (let item of await journalSegments(dir, accepts)) {
      if (item.compressed || item.file.endsWith('.kept') || item.mtimeMs > cutoff ||
          !(Date.parse(item.name.slice(0, 10)) + DAY <= cutoff)) continue;
      const space = await statfs(dir);
      const budget = archiveByteBudget(item.size, space.bavail * space.bsize);
      if (budget === 0) {
        if (item.size <= 1) continue;
        throw new ArchiveSpaceError('Insufficient space to compress journal while preserving live write reserve');
      }
      const reservation = await options.reserve?.(budget, item);
      try {
        const allowed = Math.min(budget, reservation?.bytes ?? budget);
        if (allowed < 1) continue;
        if (item.key === item.name) {
          const sealed = sealedName(item.name, item.identity, item.birth!);
          const target = path.join(dir, sealed);
          const rotate = async () => {
            const current = await stat(item.file);
            if (current.dev + ':' + current.ino !== item.identity || Math.round(current.birthtimeMs * 1000) !== item.birth || current.mtimeMs !== item.mtimeMs) return;
            await rename(item.file, target);
            item = {...item, file:target, key:sealed.slice(0,-7)};
          };
          try { if (options.rotate) await options.rotate(rotate); else await rotate(); }
          catch (e) { if (missing(e)) continue; throw e; }
          if (item.key === item.name) continue;
        }
        try { await compress(item, options.indexTime ?? false, allowed); }
        catch (e) { if (!missing(e)) throw e; }
      } finally {
        reservation?.release();
      }
      if (!--remaining) break;
    }
  }).finally(() => { archiving.delete(dir); });
  archiveQueue = work.catch(() => {});
  archiving.set(dir, work);
  return work;
}
