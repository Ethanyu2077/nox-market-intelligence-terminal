import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryEvent } from '../shared/history.ts';
import type { ResearchJob } from '../shared/research-job.ts';
import { scanHistory } from './history-scan.ts';
import { buildFactorEvidence, factorSamplesFromL2, factorSamplesFromSnapshots, resampleFactorSamples, FACTOR_TIMEFRAMES } from './crossfactor.ts';

type Store = { page: (projectId: string, query: Record<string, unknown>) => Promise<{ items: HistoryEvent[]; nextCursor: string | null }> };

export interface ResearchJobLimits {
  maxConcurrent: number;
  maxRecords: number;
  maxRuntimeMs: number;
  pageLimit: number;
  pageTimeoutMs: number;
  /** Terminal jobs are pruned after this TTL. */
  terminalTtlMs: number;
  /** Hard cap on retained jobs (running jobs are never pruned). */
  maxRetained: number;
  /** Serialized report larger than this becomes PARTIAL with report-too-large. */
  maxReportBytes: number;
}

export const DEFAULT_RESEARCH_JOB_LIMITS: ResearchJobLimits = {
  maxConcurrent: Number(process.env.NOX_RESEARCH_MAX_JOBS ?? 2),
  maxRecords: Number(process.env.NOX_RESEARCH_MAX_RECORDS ?? 200_000),
  maxRuntimeMs: Number(process.env.NOX_RESEARCH_TIMEOUT_MS ?? 300_000),
  pageLimit: Number(process.env.NOX_RESEARCH_PAGE_LIMIT ?? 500),
  // Local-journal scans can exceed 3s on a large journal; the DB path is still bounded
  // by NOX_DB_STATEMENT_TIMEOUT_MS. Operators can override this per deployment.
  pageTimeoutMs: Number(process.env.NOX_RESEARCH_PAGE_TIMEOUT_MS ?? 10_000),
  terminalTtlMs: Number(process.env.NOX_RESEARCH_TTL_MS ?? 86_400_000),
  maxRetained: Number(process.env.NOX_RESEARCH_MAX_RETAINED ?? 100),
  maxReportBytes: Number(process.env.NOX_RESEARCH_MAX_REPORT_BYTES ?? 2_000_000),
};

export interface ResearchJobOptions { dataDirectory?: string; now?: () => number }

/** Full research parameters decide reuse; different window/asOf must never collide. */
export function researchFingerprint(projectId: string, params: { factor: string; timeframe: string; start?: number | null; end?: number | null; asOf: number }): string {
  return JSON.stringify([projectId, params.factor, params.timeframe, params.start ?? null, params.end ?? null, params.asOf]);
}

interface JobRecord { job: ResearchJob; controller: AbortController; done: Promise<void> }

const TERMINAL: ResearchJob['status'][] = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

export class ResearchJobManager {
  private jobs = new Map<string, JobRecord>();
  private statePath: string | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(private history: Store, private limits: ResearchJobLimits = DEFAULT_RESEARCH_JOB_LIMITS, options: ResearchJobOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.dataDirectory) this.statePath = path.join(options.dataDirectory, 'research-jobs.json');
    this.timer = setInterval(() => { this.prune(); }, 60_000);
    this.timer.unref?.();
  }

  /** Loads persisted jobs; unfinished jobs become INTERRUPTED instead of pretending to run. */
  static async open(history: Store, limits: ResearchJobLimits = DEFAULT_RESEARCH_JOB_LIMITS, options: ResearchJobOptions = {}): Promise<ResearchJobManager> {
    const manager = new ResearchJobManager(history, limits, options);
    if (!manager.statePath) return manager;
    try {
      const raw = await readFile(manager.statePath, 'utf8');
      const parsed = JSON.parse(raw) as { jobs?: ResearchJob[] };
      for (const job of parsed.jobs ?? []) {
        if (!job?.id || !job.projectId) continue;
        if (job.status === 'RUNNING' || job.status === 'QUEUED') { job.status = 'INTERRUPTED'; job.updatedAt = manager.now(); }
        manager.jobs.set(job.id, { job, controller: new AbortController(), done: Promise.resolve() });
      }
    } catch { /* no state yet */ }
    manager.prune();
    await manager.flush();
    return manager;
  }

  list(projectId: string): ResearchJob[] { return [...this.jobs.values()].map((record) => record.job).filter((job) => job.projectId === projectId); }
  get(id: string): ResearchJob | null { return this.jobs.get(id)?.job ?? null; }
  size(): number { return this.jobs.size; }

  create(projectId: string, params: { factor: string; timeframe: string; start?: number | null; end?: number | null; asOf?: number }): { job: ResearchJob; duplicate: boolean } {
    // A default cutoff is aligned to the minute: two clicks in the same minute are the
    // same research request, while an explicit or later asOf still yields a new job.
    const asOf = params.asOf ?? Math.floor(this.now() / 60_000) * 60_000;
    const fingerprint = researchFingerprint(projectId, { factor: params.factor, timeframe: params.timeframe, start: params.start, end: params.end, asOf });
    const active = [...this.jobs.values()].find((record) => record.job.fingerprint === fingerprint && ['QUEUED', 'RUNNING'].includes(record.job.status));
    if (active) return { job: active.job, duplicate: true };
    const running = [...this.jobs.values()].filter((record) => ['QUEUED', 'RUNNING'].includes(record.job.status)).length;
    if (running >= this.limits.maxConcurrent) {
      const job = this.make(projectId, params, asOf, fingerprint);
      job.status = 'FAILED';
      job.error = 'Concurrent research job limit reached; retry later';
      this.jobs.set(job.id, { job, controller: new AbortController(), done: Promise.resolve() });
      void this.flush();
      return { job, duplicate: false };
    }
    const job = this.make(projectId, params, asOf, fingerprint);
    const controller = new AbortController();
    const record: JobRecord = { job, controller, done: Promise.resolve() };
    this.jobs.set(job.id, record);
    this.prune();
    void this.flush();
    record.done = this.run(record);
    return { job, duplicate: false };
  }

  cancel(id: string): ResearchJob | null {
    const record = this.jobs.get(id);
    if (!record) return null;
    if (['QUEUED', 'RUNNING'].includes(record.job.status)) {
      record.controller.abort();
      record.job.status = 'CANCELLED';
      record.job.updatedAt = this.now();
      void this.flush();
    }
    return record.job;
  }

  async wait(id: string): Promise<ResearchJob | null> {
    const record = this.jobs.get(id);
    if (!record) return null;
    await record.done;
    return record.job;
  }

  prune(now = this.now()): void {
    const terminal = [...this.jobs.entries()].filter(([, record]) => TERMINAL.includes(record.job.status));
    for (const [id, record] of terminal) {
      if (now - record.job.updatedAt > this.limits.terminalTtlMs) this.jobs.delete(id);
    }
    const remaining = [...this.jobs.entries()].filter(([, record]) => TERMINAL.includes(record.job.status));
    if (remaining.length > this.limits.maxRetained) {
      remaining.sort((a, b) => a[1].job.updatedAt - b[1].job.updatedAt);
      for (const [id] of remaining.slice(0, remaining.length - this.limits.maxRetained)) this.jobs.delete(id);
    }
  }

  async flush(): Promise<void> {
    if (!this.statePath) return;
    const pathName = this.statePath;
    const jobs = [...this.jobs.values()].map((record) => record.job);
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(path.dirname(pathName), { recursive: true });
      const temp = `${pathName}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
      await rename(temp, pathName);
    }).catch(() => undefined);
    await this.persistChain;
  }

  close(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private make(projectId: string, params: { factor: string; timeframe: string; start?: number | null; end?: number | null }, asOf: number, fingerprint: string): ResearchJob {
    const now = this.now();
    return {
      id: `job_${randomUUID()}`, projectId, factor: params.factor, timeframe: params.timeframe, fingerprint,
      status: 'QUEUED', createdAt: now, updatedAt: now, asOf, start: params.start ?? null, end: params.end ?? null,
      progress: { scanned: 0, snapshotCursor: null, l2Cursor: null, snapshotDone: false, l2Done: false },
      report: null, error: null, truncationReason: null,
    };
  }

  private async run(record: JobRecord): Promise<void> {
    const { job, controller } = record;
    job.status = 'RUNNING';
    const started = this.now();
    const events = new Map<string, HistoryEvent>();
    let reason: string | null = null;
    try {
      for (const kind of ['snapshot', 'l2'] as const) {
        let cursor: string | null = null;
        let done = false;
        while (!done) {
          if (controller.signal.aborted) { job.status = 'CANCELLED'; return; }
          if (this.now() - started > this.limits.maxRuntimeMs) { reason = 'timeout'; break; }
          if (events.size >= this.limits.maxRecords) { reason = 'max-records'; break; }
          const scan = await scanHistory(this.history as never, job.projectId, {
            kind, from: job.start ?? undefined, to: job.end ?? undefined, asOf: job.asOf, cursor,
            limit: this.limits.pageLimit, maxPages: 1, maxRecords: this.limits.pageLimit,
            timeoutMs: this.limits.pageTimeoutMs, signal: controller.signal,
          });
          for (const item of scan.items) events.set(item.id, item);
          cursor = scan.cursor;
          if (kind === 'snapshot') job.progress.snapshotCursor = cursor; else job.progress.l2Cursor = cursor;
          job.progress.scanned = events.size;
          job.updatedAt = this.now();
          if (scan.reason === 'max-pages' || scan.reason === 'max-records') { done = !cursor; continue; }
          if (scan.reason === 'cancelled') { job.status = 'CANCELLED'; return; }
          if (scan.reason) {
            reason = scan.reason;
            if (scan.reason === 'query-error') { job.status = 'FAILED'; job.error = 'Historical query failed'; return; }
            break;
          }
          done = !cursor;
        }
        if (reason) break;
        if (kind === 'snapshot') job.progress.snapshotDone = true; else job.progress.l2Done = true;
      }

      if (controller.signal.aborted) { job.status = 'CANCELLED'; return; }
      const snapshotItems = [...events.values()].filter((event) => event.kind === 'snapshot');
      const l2Items = [...events.values()].filter((event) => event.kind === 'l2');
      const bucketMs = FACTOR_TIMEFRAMES[job.timeframe] ?? 300_000;
      const raw = [...factorSamplesFromSnapshots(snapshotItems), ...factorSamplesFromL2(l2Items)].filter((sample) => sample.factor === job.factor);
      const report = buildFactorEvidence(job.factor as never, resampleFactorSamples(raw, bucketMs), {
        bucketMs,
        ...(job.start ? { windowStart: job.start } : {}),
        ...(job.end ? { windowEnd: job.end } : {}),
      });
      let complete = !reason;
      let reportValue: unknown = {
        ...report, partial: !complete, researchComplete: complete,
        scannedRecords: job.progress.scanned, asOf: job.asOf,
        snapshotCursor: job.progress.snapshotCursor, l2Cursor: job.progress.l2Cursor,
        truncationReason: reason,
      };
      const serialized = JSON.stringify(reportValue);
      if (serialized.length > this.limits.maxReportBytes) {
        complete = false; reason = 'report-too-large';
        reportValue = { ...report, partial: true, researchComplete: false, reportTooLarge: true, truncationReason: reason, scannedRecords: job.progress.scanned };
      }
      job.truncationReason = reason;
      job.report = reportValue;
      job.status = complete ? 'COMPLETED' : 'PARTIAL';
    } catch (error) {
      job.status = 'FAILED';
      job.error = error instanceof Error ? error.message.slice(0, 200) : 'Research job failed';
    } finally {
      job.updatedAt = this.now();
      this.prune();
      await this.flush();
    }
  }
}
