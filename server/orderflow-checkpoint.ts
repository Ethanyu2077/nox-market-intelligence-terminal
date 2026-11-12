import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotBudget } from './snapshot-budget.ts';
import type { FlowGap, FlowTrade, LiquidationEvent } from '../shared/orderflow.ts';

type Tape = {
  trades: FlowTrade[]; gaps: FlowGap[]; liquidations: LiquidationEvent[];
  coverageFrom: number | null; coverageTo: number | null;
};
type Patch<T> = { offset: number; keep: number; tail: T[] };
type TradeRun = { offset: number; keep: number } | FlowTrade[];
type TradePatch = Patch<FlowTrade> | { runs: TradeRun[] };
type Delta = {
  trades?: TradePatch; gaps?: Patch<FlowGap>; liquidations?: Patch<LiquidationEvent>;
  coverageFrom: number | null; coverageTo: number | null;
};
// Keep small updates incremental for up to 96 checkpoints. The existing two-digit file
// names and byte budget still bound directory size and restart work.
const MAX_DELTAS = 96;
const MAX_DELTA_BYTES = 8 * 1024 * 1024;

// Tape records are immutable. Most checkpoints only discard a prefix and append new rows.
function changes<T>(previous: T[], current: T[]): Patch<T> | undefined {
  const offset = current.length ? Math.max(0, previous.indexOf(current[0])) : 0;
  let keep = 0;
  while (keep < current.length && previous[offset + keep] === current[keep]) keep++;
  if (!offset && keep === current.length && keep === previous.length) return;
  return { offset, keep, tail: current.slice(keep) };
}

function tradeChanges(previous: FlowTrade[], current: FlowTrade[]): TradePatch | undefined {
  const patch = changes(previous, current);
  if (!patch || patch.tail.length < 32 || previous.length - patch.offset - patch.keep < 32) return patch;
  // REST can fill holes anywhere in the tape. Refer to unchanged records by position so
  // a late trade near the beginning does not rewrite thousands of later trades.
  const positions = new Map<FlowTrade, number>();
  for (let i = 0; i < previous.length; i++) positions.set(previous[i], i);
  const runs: TradeRun[] = [];
  if (patch.keep) runs.push({ offset: patch.offset, keep: patch.keep });
  let reused = 0;
  for (const trade of patch.tail) {
    const index = positions.get(trade), last = runs.at(-1);
    if (index === undefined) {
      if (Array.isArray(last)) last.push(trade);
      else runs.push([trade]);
    } else {
      if (last && !Array.isArray(last) && index === last.offset + last.keep) last.keep++;
      else runs.push({ offset: index, keep: 1 });
      reused++;
    }
  }
  return reused >= 32 ? { runs } : patch;
}

function validRange(length: number, offset: number, keep: number) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(keep) &&
    offset >= 0 && keep >= 0 && offset + keep <= length;
}

function apply<T>(previous: T[], patch?: Patch<T>) {
  if (!patch) return previous;
  const { offset, keep, tail } = patch;
  if (!validRange(previous.length, offset, keep) || !Array.isArray(tail)) throw new Error('Invalid order flow checkpoint delta');
  return previous.slice(offset, offset + keep).concat(tail);
}

function applyTrades(previous: FlowTrade[], patch?: TradePatch) {
  if (!patch || !('runs' in patch)) return apply(previous, patch);
  if (!Array.isArray(patch.runs)) throw new Error('Invalid order flow checkpoint runs');
  const trades: FlowTrade[] = [];
  let reused = 0;
  for (const run of patch.runs) {
    if (Array.isArray(run)) {
      for (const trade of run) trades.push(trade);
    } else {
      if (!run || !validRange(previous.length, run.offset, run.keep)) throw new Error('Invalid order flow checkpoint range');
      reused += run.keep;
      if (reused > previous.length) throw new Error('Invalid order flow checkpoint length');
      for (let i = run.offset; i < run.offset + run.keep; i++) trades.push(previous[i]);
    }
  }
  return trades;
}

async function atomic(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** One snapshot plus a bounded sequence of atomically published deltas per market. */
export class OrderFlowCheckpoint {
  private previous?: Tape;
  private generation?: string;
  private count = 0;
  private bytes = 0;
  private baseBytes = 0;
  constructor(readonly file: string, private budget?: SnapshotBudget) {}
  private write(file: string, data: string) {
    return this.budget ? this.budget.write(path.basename(this.file), file, data) : atomic(file, data);
  }
  private get directory() { return `${this.file}.d`; }

  private async segments() {
    try { return await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  private async clean(names: string[], generation: string) {
    // A crash between publishing a new base and unlinking the old segments is safe.
    for (const name of names) {
      if (/^[a-f0-9-]{36}\.\d{2}\.json(?:\.tmp)?$/.test(name) && !name.startsWith(`${generation}.`))
        await (this.budget
          ? this.budget.remove(path.basename(this.file), path.join(this.directory, name))
          : unlink(path.join(this.directory, name))).catch(() => undefined);
    }
  }

  async load(): Promise<Tape> {
    const content = await readFile(this.file);
    const base = JSON.parse(content.toString()) as Tape & { generation?: string };
    this.baseBytes = content.length;
    let restored: Tape = { trades: base.trades, gaps: base.gaps, liquidations: base.liquidations ?? [],
      coverageFrom: base.coverageFrom, coverageTo: base.coverageTo };
    this.generation = base.generation;
    this.count = 0;
    this.bytes = 0;
    if (this.generation) {
      const names = await this.segments();
      const segments = names.filter(name => name.startsWith(`${this.generation}.`) && name.endsWith('.json')).sort();
      for (const name of segments) {
        const sequence = Number(name.slice(this.generation.length + 1, -5));
        if (sequence !== this.count + 1) throw new Error('Missing order flow checkpoint delta');
        const data = await readFile(path.join(this.directory, name));
        const delta: Delta = JSON.parse(data.toString());
        restored = { trades: applyTrades(restored.trades, delta.trades), gaps: apply(restored.gaps, delta.gaps),
          liquidations: apply(restored.liquidations, delta.liquidations), coverageFrom: delta.coverageFrom, coverageTo: delta.coverageTo };
        this.count++; this.bytes += data.length;
      }
      await this.clean(names, this.generation);
    }
    this.previous = restored;
    return restored;
  }

  async save(feed: Tape) {
    // Take immutable array views before yielding; live trades continue during filesystem I/O.
    const next: Tape = { trades: feed.trades.slice(), gaps: feed.gaps.slice(), liquidations: feed.liquidations.slice(),
      coverageFrom: feed.coverageFrom, coverageTo: feed.coverageTo };
    if (this.previous && this.generation) {
      const delta: Delta = { trades: tradeChanges(this.previous.trades, next.trades), gaps: changes(this.previous.gaps, next.gaps),
        liquidations: changes(this.previous.liquidations, next.liquidations), coverageFrom: next.coverageFrom, coverageTo: next.coverageTo };
      if (!delta.trades && !delta.gaps && !delta.liquidations &&
          delta.coverageFrom === this.previous.coverageFrom && delta.coverageTo === this.previous.coverageTo) return;
      if (this.count < MAX_DELTAS) {
        const data = JSON.stringify(delta);
        const bytes = Buffer.byteLength(data);
        const budget = Math.min(MAX_DELTA_BYTES, Math.max(64 * 1024, this.baseBytes));
        if (this.bytes + bytes <= budget) {
          const name = `${this.generation}.${String(this.count + 1).padStart(2, '0')}.json`;
          await this.write(path.join(this.directory, name), data);
          this.count++; this.bytes += bytes; this.previous = next;
          return { kind: 'delta' as const, bytes };
        }
      }
    }
    const generation = randomUUID();
    const data = JSON.stringify({ generation, ...next });
    await this.write(this.file, data);
    this.previous = next; this.generation = generation; this.count = 0; this.bytes = 0; this.baseBytes = Buffer.byteLength(data);
    await this.clean(await this.segments(), generation);
    return { kind: 'base' as const, bytes: this.baseBytes };
  }
}
