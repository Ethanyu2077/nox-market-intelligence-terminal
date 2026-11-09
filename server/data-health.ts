import type { DataHealthReport, HealthIssue, HealthState, ProjectCoverageHealth, SourceHealth } from '../shared/data-health.ts';

export interface HealthInputs {
  now: number;
  storage: { mode: string; connected: boolean; journalBytes?: number | null; pendingBytes?: number | null; rows?: number | null };
  collectors: Array<{ projectId: string; mode: string; error: string | null; checkedAt: number | null }>;
  l2: { activeFeeds: number; sampled: number; lastPersistAt: number | null };
  breakers: Array<{ exchange: string; family: string; state: string; lastError?: string | null; lastFailureAt?: number | null; lastSuccessAt?: number | null }>;
  projects: Array<{
    id: string;
    name: string;
    mode: string;
    venues: { snapshots: Array<{ exchange: string; symbol: string; marketType: string; price: number | null; oiBase: number | null; fundingRate: number | null; volume24hUsd: number | null; eventTime: number; fetchedAt: number; quality: string; source?: string | null; unavailable?: string[] }> };
    coverage: { expectedCadenceMs?: number | null; kinds?: Array<{ kind: string; state: string; sampledEvents: number; lastIngestAgeMs: number | null; gaps: number; from: number | null; to: number | null }>; summary?: { notes?: string[] } };
  }>;
}

const STALE_AFTER_MS = 15 * 60_000;
const PARTIAL_AFTER_MS = 5 * 60_000;

/** Quality + freshness decide state; HTTP 200 or a non-null price alone is not enough. */
export function classifySource(input: { quality?: string | null; delayMs: number | null; hasMetric: boolean; coveragePct?: number | null }): HealthState {
  if (!input.hasMetric) return 'UNAVAILABLE';
  if (input.quality === 'stale' || input.quality === 'unavailable') return 'STALE';
  if (input.delayMs == null) return 'NOT VERIFIED';
  if (input.delayMs > STALE_AFTER_MS) return 'STALE';
  if (input.quality === 'partial' || input.delayMs > PARTIAL_AFTER_MS) return 'PARTIAL';
  if (input.coveragePct != null && input.coveragePct < 90) return 'PARTIAL';
  return 'LIVE';
}

function worst(states: HealthState[]): HealthState {
  const rank: Record<HealthState, number> = { LIVE: 0, PARTIAL: 1, 'NOT VERIFIED': 2, STALE: 3, UNAVAILABLE: 4 };
  return states.reduce<HealthState>((acc, state) => rank[state] > rank[acc] ? state : acc, 'LIVE');
}

export function buildDataHealth(inputs: HealthInputs): DataHealthReport {
  const { now } = inputs;
  const storageStatus = inputs.storage.connected ? (inputs.storage.mode.startsWith('timescaledb') ? 'timescaledb' : 'local-journal') : 'disconnected';
  const issues: HealthIssue[] = [];
  const sources: SourceHealth[] = [];
  const projects: ProjectCoverageHealth[] = [];

  for (const project of inputs.projects) {
    const collector = inputs.collectors.find((item) => item.projectId === project.id);
    for (const venue of project.venues.snapshots ?? []) {
      const delayMs = venue.eventTime ? Math.max(0, now - venue.eventTime) : null;
      const hasMetric = venue.price != null || venue.oiBase != null || venue.fundingRate != null || venue.volume24hUsd != null;
      const state = classifySource({ quality: venue.quality, delayMs, hasMetric });
      const breaker = inputs.breakers.find((item) => item.exchange === venue.exchange && item.family === 'snapshot');
      const evidence = [
        `quality=${venue.quality}`,
        delayMs == null ? 'eventTime missing' : `delay=${Math.round(delayMs / 1000)}s`,
        hasMetric ? 'metrics present' : 'all metrics null',
        breaker ? `breaker=${breaker.state}` : 'breaker=unknown',
      ];
      sources.push({
        projectId: project.id, projectName: project.name,
        exchange: venue.exchange, symbol: venue.symbol, marketType: venue.marketType,
        source: venue.source ?? null,
        collectorStatus: (collector?.mode as SourceHealth['collectorStatus']) ?? 'unknown',
        lastEventTime: venue.eventTime ?? null, lastReceivedTime: venue.fetchedAt ?? null,
        delayMs, coveragePct: null, missingWindows: null, sequenceGaps: null, resyncCount: null,
        integrity: null, errorCategory: breaker?.lastError ? 'exchange-error' : null,
        storageStatus, state, evidence,
      });
      if (state === 'STALE') issues.push({ severity: 'warning', category: 'data-delay', source: `${venue.exchange}:${venue.symbol}`, detail: `snapshot is ${Math.round((delayMs ?? 0) / 1000)}s old`, firstSeen: null, lastSeen: now, recovery: 'open' });
      if (state === 'UNAVAILABLE') issues.push({ severity: 'critical', category: 'missing-metrics', source: `${venue.exchange}:${venue.symbol}`, detail: 'price/OI/funding/volume are all null', firstSeen: null, lastSeen: now, recovery: 'open' });
    }

    const kinds = project.coverage.kinds ?? [];
    projects.push({
      projectId: project.id, projectName: project.name, mode: project.mode,
      cadenceMs: project.coverage.expectedCadenceMs ?? null,
      kinds: kinds.map((kind) => ({ ...kind })),
      notes: project.coverage.summary?.notes ?? [],
    });
    for (const kind of kinds) {
      if (kind.state === 'stale') issues.push({ severity: 'warning', category: 'history-gap', source: `${project.name}:${kind.kind}`, detail: `last ingest ${Math.round((kind.lastIngestAgeMs ?? 0) / 1000)}s ago, ${kind.gaps} gaps`, firstSeen: null, lastSeen: now, recovery: 'open' });
    }
    if (collector?.error) issues.push({ severity: 'critical', category: 'collector-error', source: project.name, detail: collector.error.slice(0, 160), firstSeen: null, lastSeen: now, recovery: 'open' });
  }

  for (const breaker of inputs.breakers) {
    if (breaker.state === 'open' || breaker.state === 'half-open') {
      issues.push({
        severity: breaker.state === 'open' ? 'critical' : 'warning',
        category: 'exchange-circuit', source: `${breaker.exchange}:${breaker.family}`,
        detail: breaker.lastError?.slice(0, 160) ?? breaker.state,
        firstSeen: breaker.lastFailureAt ?? null, lastSeen: breaker.lastSuccessAt ?? breaker.lastFailureAt ?? now,
        recovery: breaker.state === 'open' ? 'open' : 'unknown',
      });
    }
  }

  if (!inputs.storage.connected) issues.push({ severity: 'warning', category: 'storage-local', source: 'history', detail: `storage is ${inputs.storage.mode}; no TimescaleDB connection`, firstSeen: null, lastSeen: now, recovery: 'open' });
  if ((inputs.storage.pendingBytes ?? 0) > 0) issues.push({ severity: 'warning', category: 'journal-backlog', source: 'history', detail: `${inputs.storage.pendingBytes} bytes pending`, firstSeen: null, lastSeen: now, recovery: 'open' });
  if (inputs.l2.activeFeeds === 0) issues.push({ severity: 'info', category: 'l2-idle', source: 'l2', detail: 'no active L2 feeds (projects are Standard or unsupported venue)', firstSeen: null, lastSeen: now, recovery: 'open' });

  const states = sources.map((source) => source.state);
  const count = (state: HealthState) => states.filter((item) => item === state).length;
  const l2State: HealthState = inputs.l2.activeFeeds > 0 ? 'LIVE' : 'NOT VERIFIED';
  return {
    generatedAt: now,
    overall: {
      state: sources.length ? worst(states) : 'NOT VERIFIED',
      live: count('LIVE'), partial: count('PARTIAL'), stale: count('STALE'),
      unavailable: count('UNAVAILABLE'), notVerified: count('NOT VERIFIED'),
    },
    sources, projects, issues,
    storage: { mode: inputs.storage.mode, connected: inputs.storage.connected, journalBytes: inputs.storage.journalBytes ?? null, pendingBytes: inputs.storage.pendingBytes ?? null, rows: inputs.storage.rows ?? null },
    collectors: inputs.collectors,
    l2: { ...inputs.l2, state: l2State },
  };
}
