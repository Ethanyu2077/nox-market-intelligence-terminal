/** Unified data-health vocabulary used by the API and Settings. */
export type HealthState = 'LIVE' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE' | 'NOT VERIFIED';

export interface HealthIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  source: string;
  detail: string;
  firstSeen: number | null;
  lastSeen: number;
  recovery: 'open' | 'recovered' | 'unknown';
}

export interface SourceHealth {
  projectId: string;
  projectName: string;
  exchange: string;
  symbol: string;
  marketType: string;
  source: string | null;
  collectorStatus: 'active' | 'standard' | 'paused' | 'unknown';
  lastEventTime: number | null;
  lastReceivedTime: number | null;
  delayMs: number | null;
  coveragePct: number | null;
  missingWindows: number | null;
  sequenceGaps: number | null;
  resyncCount: number | null;
  integrity: string | null;
  errorCategory: string | null;
  storageStatus: 'timescaledb' | 'local-journal' | 'disconnected';
  state: HealthState;
  evidence: string[];
}

export interface ProjectCoverageHealth {
  projectId: string;
  projectName: string;
  mode: string;
  cadenceMs: number | null;
  kinds: Array<{ kind: string; state: string; sampledEvents: number; lastIngestAgeMs: number | null; gaps: number; from: number | null; to: number | null }>;
  notes: string[];
}

export interface DataHealthReport {
  generatedAt: number;
  overall: { state: HealthState; live: number; partial: number; stale: number; unavailable: number; notVerified: number };
  sources: SourceHealth[];
  projects: ProjectCoverageHealth[];
  issues: HealthIssue[];
  storage: { mode: string; connected: boolean; journalBytes: number | null; pendingBytes: number | null; rows: number | null };
  collectors: Array<{ projectId: string; mode: string; error: string | null; checkedAt: number | null }>;
  l2: { activeFeeds: number; sampled: number; lastPersistAt: number | null; state: HealthState };
}
