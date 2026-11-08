import { randomUUID } from 'node:crypto';
import type { HistoryEvent } from '../shared/history.ts';
import type { ResearchJob } from '../shared/research-job.ts';
import { scanHistory } from './history-scan.ts';
import { buildFactorEvidence, factorSamplesFromL2, factorSamplesFromSnapshots, resampleFactorSamples, FACTOR_TIMEFRAMES } from './crossfactor.ts';

export interface ResearchJobLimits {
  maxConcurrent: number;
  maxRecords: number;
  maxRuntimeMs: number;
  pageLimit: number;
  pageTimeoutMs: number;
}

export const DEFAULT_RESEARCH_JOB_LIMITS: ResearchJobLimits = {
  maxConcurrent: Number(process.env.NOX_RESEARCH_MAX_JOBS ?? 2),
  maxRecords: Number(process.env.NOX_RESEARCH_MAX_RECORDS ?? 200_000),
  maxRuntimeMs: Number(process.env.NOX_RESEARCH_TIMEOUT_MS ?? 300_000),
  pageLimit: Number(process.env.NOX_RESEARCH_PAGE_LIMIT ?? 500),
  pageTimeoutMs: Number(process.env.NOX_RESEARCH_PAGE_TIMEOUT_MS ?? 3_000),
};

type Store = { page: (projectId: string, query: Record<string, unknown>) => Promise<{ items: HistoryEvent[]; nextCursor: string | null }> };

interface JobRecord {
  job: ResearchJob;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Minimal asynchronous full-history job manager.
 *
 * Each page is a bounded scanHistory call; cursors are carried forward for snapshot and L2
 * independently, events are deduplicated by id, asOf is fixed for the whole job, and limits
 * turn an over-budget run into PARTIAL rather than COMPLETED.
 */
export class ResearchJobManager {
  private jobs = new Map<string, JobRecord>();

  constructor(private history: Store, private limits: ResearchJobLimits = DEFAULT_RESEARCH_JOB_LIMITS) {}

  list(projectId: string): ResearchJob[] {
    return [...this.jobs.values()].map((record) => record.job).filter((job) => job.projectId === projectId);
  }

  get(id: string): ResearchJob | null { return this.jobs.get(id)?.job ?? null; }

  size(): number { return this.jobs.size; }

  create(projectId: string, params: { factor: string; timeframe: string; start?: number | null; end?: number | null; asOf?: number }): { job: ResearchJob; duplicate: boolean } {
    const active = [...this.jobs.values()].find((record) => record.job.projectId === projectId
      && ['QUEUED', 'RUNNING'].includes(record.job.status)
      && record.job.factor === params.factor && record.job.timeframe === params.timeframe);
    if (active) return { job: active.job, duplicate: true };
    const running = [...this.jobs.values()].filter((record) => ['QUEUED', 'RUNNING'].includes(record.job.status)).length;
    if (running >= this.limits.maxConcurrent) {
      const job = this.make(projectId, params);
      job.status = 'FAILED';
      job.error = 'Concurrent research job limit reached; retry later';
      this.jobs.set(job.id, { job, controller: new AbortController(), done: Promise.resolve() });
      return { job, duplicate: false };
    }
    const job = this.make(projectId, params);
    const controller = new AbortController();
    const record: JobRecord = { job, controller, done: Promise.resolve() };
    this.jobs.set(job.id, record);
    record.done = this.run(record);
    return { job, duplicate: false };
  }

  cancel(id: string): ResearchJob | null {
    const record = this.jobs.get(id);
    if (!record) return null;
    if (['QUEUED', 'RUNNING'].includes(record.job.status)) {
      record.controller.abort();
      record.job.status = 'CANCELLED';
      record.job.updatedAt = Date.now();
    }
    return record.job;
  }

  async wait(id: string): Promise<ResearchJob | null> {
    const record = this.jobs.get(id);
    if (!record) return null;
    await record.done;
    return record.job;
  }

  private make(projectId: string, params: { factor: string; timeframe: string; start?: number | null; end?: number | null; asOf?: number }): ResearchJob {
    const now = Date.now();
    return {
      id: `job_${randomUUID()}`,
      projectId, factor: params.factor, timeframe: params.timeframe,
      status: 'QUEUED', createdAt: now, updatedAt: now,
      asOf: params.asOf ?? now, start: params.start ?? null, end: params.end ?? null,
      progress: { scanned: 0, snapshotCursor: null, l2Cursor: null, snapshotDone: false, l2Done: false },
      report: null, error: null, truncationReason: null,
    };
  }

  private async run(record: JobRecord): Promise<void> {
    const { job, controller } = record;
    job.status = 'RUNNING';
    const started = Date.now();
    const events = new Map<string, HistoryEvent>();
    let reason: string | null = null;
    try {
      for (const kind of ['snapshot', 'l2'] as const) {
        let cursor: string | null = null;
        let done = false;
        while (!done) {
          if (controller.signal.aborted) { job.status = 'CANCELLED'; return; }
          if (Date.now() - started > this.limits.maxRuntimeMs) { reason = 'timeout'; break; }
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
          job.updatedAt = Date.now();
          // A page-sized scan reports max-pages/max-records even when the cursor proves
          // the page was fully consumed; only a bounded page without a cursor truncates.
          if (scan.reason === 'max-pages' || scan.reason === 'max-records') { done = !cursor; continue; }
          if (scan.reason) { reason = scan.reason; if (scan.reason === 'query-error') { job.status = 'FAILED'; job.error = 'Historical query failed'; return; } break; }
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
      const complete = !reason;
      job.truncationReason = reason;
      job.report = {
        ...report, partial: !complete, researchComplete: complete,
        scannedRecords: job.progress.scanned, asOf: job.asOf,
        snapshotCursor: job.progress.snapshotCursor, l2Cursor: job.progress.l2Cursor,
        truncationReason: reason,
      };
      job.status = complete ? 'COMPLETED' : 'PARTIAL';
    } catch (error) {
      job.status = 'FAILED';
      job.error = error instanceof Error ? error.message.slice(0, 200) : 'Research job failed';
    } finally {
      job.updatedAt = Date.now();
    }
  }
}
