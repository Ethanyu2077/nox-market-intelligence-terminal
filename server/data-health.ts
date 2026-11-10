import type { DataHealthReport, HealthIssue, HealthState, ProjectCoverageHealth, SourceHealth } from '../shared/data-health.ts';

export interface HealthInputs {
  now: number;
  storage: { mode: string; connected: boolean; journalBytes?: number | null; pendingBytes?: number | null; rows?: number | null };
  collectors: Array<{ projectId: string; mode: string; error: string | null; checkedAt: number | null }>;
  binance?: { bannedUntil: number | null; banReason: string | null; failures: number; lastSuccessAt: number | null };
  providers?: Array<{ provider: string; state: HealthState; configured: boolean; lastSuccessAt: number | null; lastFailureAt: number | null; lastLatencyMs: number | null; lastReason: string | null }>;
  l2: { activeFeeds: number; sampled: number; lastPersistAt: number | null; feeds?: Array<{ venue: string; symbol: string; state: string; sequence: number | null; epoch: number | null; verified: boolean; integrity: string; gaps: number; resyncs: number; lastMessageAt: number | null }> };
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

export function classifyStorage(input: { mode: string; connected: boolean; pendingBytes?: number | null }): 'LOCAL_JOURNAL' | 'TIMESCALE_CONNECTED' | 'TIMESCALE_DISCONNECTED' | 'STORAGE_DEGRADED' | 'NOT VERIFIED' {
  if (!input.mode) return 'NOT VERIFIED';
  if (!input.connected) return input.mode.startsWith('timescaledb') ? 'TIMESCALE_DISCONNECTED' : 'LOCAL_JOURNAL';
  if ((input.pendingBytes ?? 0) > 0) return 'STORAGE_DEGRADED';
  return input.mode.startsWith('timescaledb') ? 'TIMESCALE_CONNECTED' : 'LOCAL_JOURNAL';
}

export function classifyL2(feeds: NonNullable<HealthInputs['l2']['feeds']>, now: number): HealthState {
  if (!feeds.length) return 'NOT VERIFIED';
  const live = feeds.filter((feed) => feed.state === 'live' && feed.verified && feed.integrity === 'ok' && feed.lastMessageAt != null && now - feed.lastMessageAt < 60_000);
  if (!live.length) return 'UNAVAILABLE';
  if (live.length < feeds.length) return 'PARTIAL';
  return 'LIVE';
}
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
  const storageStatus = classifyStorage(inputs.storage);
  const l2Feeds = inputs.l2.feeds ?? [];
  const l2State = classifyL2(l2Feeds, now);
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

  if (storageStatus === 'TIMESCALE_DISCONNECTED') issues.push({ severity: 'critical', category: 'storage-degraded', source: 'history', detail: 'TimescaleDB is configured but disconnected; local journal is the fallback', firstSeen: null, lastSeen: now, recovery: 'open' });
  else if (storageStatus === 'LOCAL_JOURNAL') issues.push({ severity: 'info', category: 'storage-local', source: 'history', detail: 'running on the local journal (no TimescaleDB connection)', firstSeen: null, lastSeen: now, recovery: 'open' });
  else if (storageStatus === 'STORAGE_DEGRADED') issues.push({ severity: 'warning', category: 'storage-backlog', source: 'history', detail: `${inputs.storage.pendingBytes} bytes pending`, firstSeen: null, lastSeen: now, recovery: 'open' });
  if ((inputs.storage.pendingBytes ?? 0) > 0) issues.push({ severity: 'warning', category: 'journal-backlog', source: 'history', detail: `${inputs.storage.pendingBytes} bytes pending`, firstSeen: null, lastSeen: now, recovery: 'open' });
  if (inputs.l2.activeFeeds === 0) issues.push({ severity: 'info', category: 'l2-idle', source: 'l2', detail: 'no active L2 feeds (projects are Standard or unsupported venue)', firstSeen: null, lastSeen: now, recovery: 'open' });
  else if (l2State !== 'LIVE') issues.push({ severity: 'warning', category: 'l2-degraded', source: 'l2', detail: `L2 feeds are ${l2State.toLowerCase()} (stale, partial or unverified)`, firstSeen: null, lastSeen: now, recovery: 'open' });

  if (inputs.binance?.bannedUntil && inputs.binance.bannedUntil > now) {
    issues.push({ severity: 'critical', category: 'binance-cooldown', source: 'binance', detail: `${inputs.binance.banReason ?? '418/429'} until ${new Date(inputs.binance.bannedUntil).toISOString()}`, firstSeen: null, lastSeen: now, recovery: 'open' });
  }
  for (const provider of inputs.providers ?? []) {
    if (!provider.configured) issues.push({ severity: 'info', category: 'provider-not-configured', source: provider.provider, detail: 'no API key configured', firstSeen: null, lastSeen: now, recovery: 'open' });
    else if (provider.state === 'UNAVAILABLE') issues.push({ severity: 'warning', category: 'provider-error', source: provider.provider, detail: provider.lastReason ?? 'provider unavailable', firstSeen: provider.lastFailureAt, lastSeen: now, recovery: 'open' });
    else if (provider.state === 'PARTIAL') issues.push({ severity: 'info', category: 'provider-partial', source: provider.provider, detail: provider.lastReason ?? 'some sections failed', firstSeen: null, lastSeen: now, recovery: 'open' });
  }

  const states = sources.map((source) => source.state);
  const count = (state: HealthState) => states.filter((item) => item === state).length;

  return {
    generatedAt: now,
    overall: {
      state: sources.length ? worst(states) : 'NOT VERIFIED',
      live: count('LIVE'), partial: count('PARTIAL'), stale: count('STALE'),
      unavailable: count('UNAVAILABLE'), notVerified: count('NOT VERIFIED'),
    },
    sources, projects, issues,
    storage: { mode: inputs.storage.mode, connected: inputs.storage.connected, state: storageStatus, journalBytes: inputs.storage.journalBytes ?? null, pendingBytes: inputs.storage.pendingBytes ?? null, rows: inputs.storage.rows ?? null },
    collectors: inputs.collectors,
    binanceRest: inputs.binance ?? null,
    providers: inputs.providers ?? [],
    l2: { activeFeeds: inputs.l2.activeFeeds, sampled: inputs.l2.sampled, lastPersistAt: inputs.l2.lastPersistAt, state: l2State, feeds: l2Feeds },
  };
}
