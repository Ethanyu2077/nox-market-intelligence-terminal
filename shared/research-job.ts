/** Asynchronous full-history research job. */
export type ResearchJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

export interface ResearchJobProgress {
  scanned: number;
  snapshotCursor: string | null;
  l2Cursor: string | null;
  snapshotDone: boolean;
  l2Done: boolean;
}

export interface ResearchJob {
  id: string;
  projectId: string;
  factor: string;
  timeframe: string;
  /** Stable hash of project + factor + timeframe + start + end + asOf. */
  fingerprint: string;
  status: ResearchJobStatus;
  createdAt: number;
  updatedAt: number;
  asOf: number;
  start: number | null;
  end: number | null;
  progress: ResearchJobProgress;
  report: unknown | null;
  error: string | null;
  truncationReason: string | null;
}
