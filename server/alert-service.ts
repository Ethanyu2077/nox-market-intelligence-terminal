import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AlertRule, MarketProject, ProjectVenueResponse } from '../shared/types.ts';
import type { AlertEvent, AlertEvaluation, AlertsStatus } from '../shared/alerts.ts';
import { evaluateRules, type AlertReading, type RuleRuntime } from './alert-engine.ts';
import { overview } from './binance.ts';
import { projectVenueSnapshots } from './exchanges.ts';

/**
 * Alert evaluation loop.
 *
 * Rules are symbol-scoped. A reading is resolved from the project that covers that symbol
 * (aggregate of its selected venues, using the same 5s snapshot cache as the UI), falling
 * back to the Binance public ticker when no project covers it. Missing metrics are never
 * coerced to zero: the rule is reported `unavailable` instead.
 */

export type AlertResolver = (symbol: string) => Promise<AlertReading | null>;

const MAX_EVENTS = 200;

export class AlertService {
  private events: AlertEvent[] = [];
  private runtime = new Map<string, RuleRuntime>();
  private evaluations: AlertEvaluation[] = [];
  private lastEvaluatedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private evaluating: Promise<AlertsStatus> | null = null;
  /** One venue fetch per project per tick, shared by all rules on that project. */
  private tickCache: Map<string, Promise<ProjectVenueResponse>> | null = null;
  private readonly file: string;
  private readonly resolve: AlertResolver;

  constructor(
    directory: string,
    private rules: () => AlertRule[],
    private projects: () => MarketProject[],
    private intervalMs = 30_000,
    private cooldownMs = 15 * 60_000,
    resolver?: AlertResolver,
  ) {
    this.file = path.join(directory, 'alerts', 'events.json');
    this.resolve = resolver ?? ((symbol) => this.resolveFromProjects(symbol));
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { events?: AlertEvent[] };
      this.events = (parsed.events ?? []).filter((event) => event && typeof event.id === 'string').slice(0, MAX_EVENTS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
    const readings = new Map<string, AlertReading>();
    const symbols = [...new Set(rules.filter((rule) => rule.enabled).map((rule) => rule.symbol.toUpperCase()))];
    const settled = await Promise.allSettled(symbols.map(async (symbol) => ({ symbol, reading: await this.resolve(symbol) })));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.reading) readings.set(result.value.symbol, result.value.reading);
    }
    const result = evaluateRules(rules, readings, this.runtime, now, this.cooldownMs);
    this.runtime = result.runtime;
    this.evaluations = result.evaluations;
    this.lastEvaluatedAt = now;
    if (result.events.length) {
      this.events = [...result.events, ...this.events].slice(0, MAX_EVENTS);
      await this.persist();
    }
    return this.status();
  }

  status(): AlertsStatus {
    return {
      rules: this.rules(),
      events: this.events,
      evaluations: this.evaluations,
      lastEvaluatedAt: this.lastEvaluatedAt,
      nextEvaluationAt: this.lastEvaluatedAt == null ? null : this.lastEvaluatedAt + this.intervalMs,
      intervalMs: this.intervalMs,
      cooldownMs: this.cooldownMs,
    };
  }

  async clearEvents(): Promise<void> {
    this.events = [];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify({ events: this.events }, null, 0), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }

  /** Resolve a symbol from the first project whose selected markets include it. */
  private async resolveFromProjects(symbol: string): Promise<AlertReading | null> {
    const upper = symbol.toUpperCase();
    const project = this.projects().find((candidate) => candidate.markets.some((market) => market.marketType === 'perpetual' && market.symbol.toUpperCase() === upper));
    if (!project) return this.resolveFromBinance(upper);
    const venues = await this.projectVenues(project);
    const aggregate = venues.aggregate;
    const observedAt = aggregate.eventTime ?? Date.now();
    return {
      values: {
        price_change_24h: aggregate.change24hPct,
        funding_rate: aggregate.fundingRate,
        volume_24h_usd: aggregate.volume24hUsd,
      },
      source: `${project.name} · aggregate ${aggregate.coverage.successful}/${aggregate.coverage.requested} venues`,
      observedAt,
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

  private async resolveFromBinance(symbol: string): Promise<AlertReading | null> {
    try {
      const row = await overview(symbol);
      return {
        values: {
          price_change_24h: row.change24hPct,
          funding_rate: row.fundingRate,
          volume_24h_usd: row.volume24hUsd,
        },
        source: `${row.source} (no project covers ${symbol})`,
        observedAt: row.eventTime,
      };
    } catch {
      return null;
    }
  }
}
