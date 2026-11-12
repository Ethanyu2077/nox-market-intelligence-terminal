import type { MarketProject } from "../shared/types.ts";
import type { RegimeReport } from "../shared/regime-v2.ts";
import type { HistoryEvent } from "../shared/history.ts";
import { HistoryStore, type HistoryQuery } from "./history-store.ts";
import { eventStudy, type StudyOptions } from "./event-study.ts";
import { OutcomeStore } from "./outcome-store.ts";

export class EventStudyService {
  private running = new Map<string, Promise<void>>();
  private due = new Map<string, number>();
  private errors = new Map<string, string>();
  private maintenance: NodeJS.Timeout;
  private maintenanceError: string | null = null;
  constructor(
    private history: HistoryStore,
    private outcomes: OutcomeStore,
  ) {
    const maintain = () => {
      void this.outcomes.maintain().then(() => { this.maintenanceError = null; })
        .catch(() => { this.maintenanceError = "Outcome retention maintenance failed"; });
    };
    maintain();
    this.maintenance = setInterval(maintain, 3_600_000);
    this.maintenance.unref();
  }

  storageStatus() {
    return { ...this.outcomes.status(), maintenanceError: this.maintenanceError };
  }
  private async collect(
    projectId: string,
    query: HistoryQuery,
    maximum: number,
  ) {
    const items: HistoryEvent[] = [];
    let cursor: string | undefined,
      backend = "local-journal",
      truncated = false;
    do {
      const page = await this.history.page(projectId, {
        ...query,
        cursor,
        limit: Math.min(1000, maximum - items.length),
      });
      items.push(...page.items);
      backend = page.backend;
      cursor = page.nextCursor ?? undefined;
      if (items.length >= maximum) {
        truncated = !!cursor;
        break;
      }
    } while (cursor);
    return { items, backend, truncated };
  }
  private async load(
    projectId: string,
    options: StudyOptions,
    lookbackDays: number,
  ) {
    const from = options.asOf - lookbackDays * 86_400_000;
    const events = await this.collect(
      projectId,
      {
        kind: "regime",
        source: "nox.regime.v2",
        summarizeRegime: true,
        regimeInterval: options.interval,
        from,
        asOf: options.asOf,
      },
      4000,
    );
    const selected = events.items.filter(
      (e) =>
        !options.interval ||
        (e.payload as RegimeReport).interval === options.interval,
    );
    const eligible = selected.flatMap((e) =>
      (e.payload as RegimeReport).venues.filter(
        (v) =>
          v.evidenceQuality.essentialComplete &&
          (!options.venue || v.marketKey.startsWith(`${options.venue}:`)),
      ),
    );
    const keys = [...new Set(eligible.map((v) => v.marketKey))],
      snapshots: HistoryEvent[] = [];
    let truncated = events.truncated;
    for (const marketKey of keys) {
      if (snapshots.length >= 100_000) {
        truncated = true;
        break;
      }
      const batch = await this.collect(
        projectId,
        {
          kind: "snapshot",
          priceOnly: true,
          marketKey,
          from: Math.max(0, from - 90_000),
          asOf: options.asOf,
        },
        100_000 - snapshots.length,
      );
      snapshots.push(...batch.items);
      truncated ||= batch.truncated;
    }
    return { selected, snapshots, truncated, events, from };
  }
  private evaluate(
    input: Awaited<ReturnType<EventStudyService["load"]>>,
    options: StudyOptions,
    lookbackDays: number,
  ) {
    const { selected, snapshots, truncated, events, from } = input;
    const study = eventStudy(selected, snapshots, options);
    if (truncated) {
      study.statistics = {
        sampleSize: 0,
        medianReturnPct: null,
        q10Pct: null,
        q90Pct: null,
        positivePriceFrequency: null,
        medianMfePct: null,
        medianMaePct: null,
        observedUtcDays: 0,
        confidenceInterval: null,
      };
      study.cohorts = [];
      study.limitations.unshift(
        "Historical scan limit reached; cohort statistics suppressed. Narrow the research range.",
      );
    }
    return {
      ...study,
      range: { from, to: options.asOf, lookbackDays },
      dataCoverage: {
        regimeRecords: events.items.length,
        snapshotRecords: snapshots.length,
        truncated,
        backend: events.backend,
      },
      persistence:
        "Derived outcomes recorded by the background worker; this read does not mutate frozen evidence",
    };
  }
  async study(projectId: string, options: StudyOptions, lookbackDays = 7) {
    return this.evaluate(
      await this.load(projectId, options, lookbackDays),
      options,
      lookbackDays,
    );
  }
  refresh(project: MarketProject) {
    if (
      this.running.has(project.id) ||
      Date.now() < (this.due.get(project.id) ?? 0)
    )
      return;
    this.due.set(project.id, Date.now() + 300_000);
    const task = (async () => {
      try {
        const options: StudyOptions = {
          horizonMinutes: 15,
          asOf: Date.now(),
          purgeOverlaps: false,
        };
        const input = await this.load(project.id, options, 7);
        if (input.truncated) {
          this.errors.set(
            project.id,
            "Historical scan limit reached; outcome tracking is incomplete",
          );
          return;
        }
        for (const horizonMinutes of [15, 60, 240, 1440] as const) {
          await this.outcomes.record(
            this.evaluate(input, { ...options, horizonMinutes }, 7),
          );
        }
        this.errors.delete(project.id);
      } catch {
        this.errors.set(
          project.id,
          "Event-study tracking failed; original signals remain unchanged",
        );
      }
    })().finally(() => this.running.delete(project.id));
    this.running.set(project.id, task);
  }
  status() {
    return {
      running: [...this.running.keys()],
      errors: [...this.errors].map(([projectId, message]) => ({
        projectId,
        message,
      })),
      methodology: "nox.event-study.v1",
    };
  }
  async close() {
    clearInterval(this.maintenance);
    await Promise.all(this.running.values());
    await this.outcomes.close();
  }
}
