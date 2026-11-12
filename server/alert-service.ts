import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AlertRule, MarketProject, ProjectVenueResponse } from '../shared/types.ts';
import type { AlertDelivery, AlertEvent, AlertEvaluation, AlertsStatus, AlertRuntime } from '../shared/alerts.ts';
import { MAX_READING_AGE_MS, evaluateRules, type AlertReading } from './alert-engine.ts';
import { overview } from './binance.ts';
import { marketSnapshot, projectVenueSnapshots } from './exchanges.ts';

/**
 * Alert evaluation loop.
 *
 * Rules can be scoped by project, venue, market type and timeframe. A reading is resolved
 * from the matching project market (venue-scoped) or the project aggregate, falling back to
 * the Binance public ticker when no project covers the symbol. Missing or stale metrics are
 * reported `unavailable`, never coerced to zero.
 *
 * State is persisted atomically and includes the trigger runtime, so an armed edge is not
 * re-fired after a restart. New events are appended with a deterministic idempotency key and
 * a delivery record; the local event log is the only delivery target (external publishing is
 * disabled by design).
 */

export type AlertResolver = (rule: AlertRule) => Promise<AlertReading | null>;

const MAX_EVENTS = 200;
const STATE_VERSION = 2;

interface PersistedState {
  version: number;
  events: AlertEvent[];
  runtime: Record<string, AlertRuntime>;
  deliveries: Record<string, AlertDelivery>;
}

export class AlertService {
  private events: AlertEvent[] = [];
  private runtime = new Map<string, AlertRuntime>();
  private deliveries = new Map<string, AlertDelivery>();
  private cleanupPending = false;
  private evaluations: AlertEvaluation[] = [];
  private lastEvaluatedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private evaluating: Promise<AlertsStatus> | null = null;
  /** One venue fetch per project per tick, shared by all rules on that project. */
  private tickCache: Map<string, Promise<ProjectVenueResponse>> | null = null;
  private readonly file: string;
  private readonly legacyFile: string;
  private readonly resolve: AlertResolver;

  constructor(
    directory: string,
    private rules: () => AlertRule[],
    private projects: () => MarketProject[],
    private intervalMs = 30_000,
    private cooldownMs = 15 * 60_000,
    resolver?: AlertResolver,
  ) {
    this.file = path.join(directory, 'alerts', 'state.json');
    this.legacyFile = path.join(directory, 'alerts', 'events.json');
    this.resolve = resolver ?? ((rule) => this.resolveForRule(rule));
  }

  async init(): Promise<void> {
    const state = await this.readState(this.file);
    if (state) {
      this.events = state.events;
      this.runtime = new Map(Object.entries(state.runtime ?? {}));
      this.deliveries = new Map(Object.entries(state.deliveries ?? {}));
      const removedDeliveries = this.trimDeliveries();
      if (this.trimRuntime(this.rules()) || removedDeliveries) {
        try { await this.persist(); } catch { this.cleanupPending = true; }
      }
      return;
    }
    // Migrate the v1 events-only file so existing event history is not lost.
    const legacy = await this.readState(this.legacyFile, true);
    if (legacy) this.events = legacy.events;
  }

  private async readState(file: string, legacy = false): Promise<PersistedState | null> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<PersistedState>;
      const events = (parsed.events ?? []).filter((event) => event && typeof event.id === 'string').slice(0, MAX_EVENTS);
      return {
        version: typeof parsed.version === 'number' ? parsed.version : legacy ? 1 : STATE_VERSION,
        events,
        runtime: parsed.runtime ?? {},
        deliveries: parsed.deliveries ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.evaluate().catch(() => undefined); }, this.intervalMs);
    // Do not keep the process alive just for alerts; the HTTP server owns the lifecycle.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async evaluate(now = Date.now()): Promise<AlertsStatus> {
    if (this.evaluating) return this.evaluating;
    this.evaluating = this.run(now).finally(() => { this.evaluating = null; });
    return this.evaluating;
  }

  private async run(now: number): Promise<AlertsStatus> {
    this.tickCache = new Map();
    try {
      return await this.runTick(now);
    } finally {
      this.tickCache = null;
    }
  }

  private async runTick(now: number): Promise<AlertsStatus> {
    const rules = this.rules();
    if (this.trimRuntime(rules)) this.cleanupPending = true;
    const readings = new Map<string, AlertReading>();
    const enabled = rules.filter((rule) => rule.enabled);
    const settled = await Promise.allSettled(enabled.map(async (rule) => ({ rule, reading: await this.resolve(rule) })));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.reading) readings.set(result.value.rule.id, result.value.reading);
    }

    const result = evaluateRules(rules, readings, this.runtime, now, { cooldownMs: this.cooldownMs });
    this.runtime = result.runtime;
    this.evaluations = result.evaluations;
    this.lastEvaluatedAt = now;

    const fresh = result.events.filter((event) => !this.events.some((existing) => existing.id === event.id || existing.idempotencyKey === event.idempotencyKey));
    if (fresh.length) {
      this.events = [...fresh, ...this.events].slice(0, MAX_EVENTS);
      for (const event of fresh) {
        this.deliveries.set(event.id, { eventId: event.id, status: 'pending', attempts: 0, lastAttemptAt: 0, error: null });
      }
      this.trimDeliveries();
    }
    if (this.cleanupPending || fresh.length || this.pendingDeliveries().length) await this.flush();
    return this.status();
  }

  // Delivery is local to the event log. An evicted event has no deliverable payload.
  private trimDeliveries() {
    const existing = new Set(this.events.map(event => event.id));
    const previous = this.deliveries.size;
    for (const id of this.deliveries.keys()) if (!existing.has(id)) this.deliveries.delete(id);
    return this.deliveries.size !== previous;
  }

  private trimRuntime(rules: AlertRule[]) {
    const ruleIds = new Set(rules.map(rule => rule.id));
    const previous = this.runtime.size;
    for (const id of this.runtime.keys()) if (!ruleIds.has(id)) this.runtime.delete(id);
    return this.runtime.size !== previous;
  }

  private pendingDeliveries(): AlertDelivery[] {
    return [...this.deliveries.values()].filter((delivery) => delivery.status !== 'delivered');
  }

  /** Persist state; the local event log is the delivery target. */
  private async flush(): Promise<void> {
    const pending = this.pendingDeliveries();
    const started = Date.now();
    try {
      await this.persist();
      for (const delivery of pending) {
        this.deliveries.set(delivery.eventId, { ...delivery, status: 'delivered', attempts: delivery.attempts + 1, lastAttemptAt: started, error: null });
      }
      // Rewrite once more so the delivered status is on disk, not only in memory.
      if (pending.length) await this.persist();
      this.cleanupPending = false;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : 'Persist failed';
      for (const delivery of pending) {
        this.deliveries.set(delivery.eventId, { ...delivery, status: 'failed', attempts: delivery.attempts + 1, lastAttemptAt: started, error: message });
      }
    }
  }

  status(): AlertsStatus {
    return {
      rules: this.rules(),
      events: this.events,
      evaluations: this.evaluations,
      deliveries: [...this.deliveries.values()],
      lastEvaluatedAt: this.lastEvaluatedAt,
      nextEvaluationAt: this.lastEvaluatedAt == null ? null : this.lastEvaluatedAt + this.intervalMs,
      intervalMs: this.intervalMs,
      cooldownMs: this.cooldownMs,
      stateVersion: STATE_VERSION,
    };
  }

  async clearEvents(): Promise<void> {
    this.events = [];
    this.deliveries.clear();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const state: PersistedState = {
      version: STATE_VERSION,
      events: this.events,
      runtime: Object.fromEntries(this.runtime),
      deliveries: Object.fromEntries(this.deliveries),
    };
    await writeFile(`${this.file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }

  /** Resolve one rule's reading according to its scope. */
  private async resolveForRule(rule: AlertRule): Promise<AlertReading | null> {
    const upper = rule.symbol.toUpperCase();
    const projects = this.projects();
    const project = rule.projectId
      ? projects.find((candidate) => candidate.id === rule.projectId)
      : projects.find((candidate) => candidate.markets.some((market) => market.symbol.toUpperCase() === upper && (rule.marketType == null || market.marketType === rule.marketType)));

    if (!project) {
      if (rule.venue && rule.venue !== 'binance') return null;
      return this.resolveFromBinance(upper, rule);
    }

    if (rule.venue) {
      const market = project.markets.find((item) => item.exchange === rule.venue && item.symbol.toUpperCase() === upper && (rule.marketType == null || item.marketType === rule.marketType));
      if (!market) return null;
      const snapshot = await marketSnapshot(market);
      const observedAt = snapshot.eventTime || 0;
      return this.reading({
        price_change_24h: snapshot.change24hPct,
        funding_rate: snapshot.fundingRate,
        volume_24h_usd: snapshot.volume24hUsd,
      }, `${project.name} · ${market.exchange.toUpperCase()} ${market.symbol}`, observedAt);
    }

    const venues = await this.projectVenues(project);
    const aggregate = venues.aggregate;
    return this.reading({
      price_change_24h: aggregate.change24hPct,
      funding_rate: aggregate.fundingRate,
      volume_24h_usd: aggregate.volume24hUsd,
    }, `${project.name} · aggregate ${aggregate.coverage.successful}/${aggregate.coverage.requested} venues`, aggregate.eventTime ?? 0);
  }

  private reading(values: AlertReading['values'], source: string, observedAt: number): AlertReading {
    const age = Date.now() - observedAt;
    const stale = !observedAt || age > MAX_READING_AGE_MS;
    return {
      values,
      source,
      observedAt: observedAt || 0,
      stale,
      reason: stale ? `Stale ${source} snapshot (${observedAt ? `${Math.round(age / 1000)}s old` : 'no event time'})` : undefined,
    };
  }

  private projectVenues(project: MarketProject): Promise<ProjectVenueResponse> {
    if (!this.tickCache) return projectVenueSnapshots(project.markets);
    const cached = this.tickCache.get(project.id);
    if (cached) return cached;
    const pending = projectVenueSnapshots(project.markets);
    this.tickCache.set(project.id, pending);
    return pending;
  }

  private async resolveFromBinance(symbol: string, rule: AlertRule): Promise<AlertReading | null> {
    try {
      const row = await overview(symbol);
      return this.reading({
        price_change_24h: row.change24hPct,
        funding_rate: row.fundingRate,
        volume_24h_usd: row.volume24hUsd,
      }, `${row.source} (no project covers ${symbol}${rule.venue ? ` on ${rule.venue}` : ''})`, row.eventTime);
    } catch {
      return null;
    }
  }
}
