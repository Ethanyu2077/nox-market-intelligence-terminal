import { createHash } from "node:crypto";
import type { HistoryEvent } from "../shared/history.ts";
import type { RegimeReport, RegimeWindow } from "../shared/regime-v2.ts";
import type { VenueMarketSnapshot } from "../shared/types.ts";
import type { StudyResponse, StudyRow } from "../shared/event-study.ts";

export interface StudyOptions {
  horizonMinutes: 15 | 60 | 240 | 1440;
  asOf: number;
  interval?: RegimeWindow;
  venue?: string;
  label?: string;
  minQuality?: number;
  concentration?: "all" | "high" | "low";
  maxGapMs?: number;
  purgeOverlaps?: boolean;
}
const price = (e: HistoryEvent) => {
  const p = (e.payload as VenueMarketSnapshot).price;
  return p != null &&
    Number.isFinite(p) &&
    p > 0 &&
    !["stale", "unavailable"].includes(e.quality)
    ? p
    : null;
};
function bound(rows: HistoryEvent[], time: number, upper = false) {
  let low = 0,
    high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].eventTime < time || (upper && rows[mid].eventTime === time))
      low = mid + 1;
    else high = mid;
  }
  return low;
}
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    position = (sorted.length - 1) * q,
    lo = Math.floor(position),
    hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

/** Outcomes may use later observations, but entry/cohort features must have been available at the actual decision. */
export function eventStudy(
  events: HistoryEvent[],
  snapshots: HistoryEvent[],
  options: StudyOptions,
): StudyResponse {
  const { asOf, horizonMinutes } = options,
    horizon = horizonMinutes * 60_000,
    maxGap = options.maxGapMs ?? 390_000;
  if (![15, 60, 240, 1440].includes(horizonMinutes) || !Number.isFinite(asOf))
    throw new Error("Invalid event study options");
  const markets = new Map<string, HistoryEvent[]>();
  for (const e of snapshots)
    if (
      e.kind === "snapshot" &&
      e.ingestTime <= asOf &&
      e.eventTime <= asOf &&
      price(e) != null
    ) {
      const key = `${e.projectId}:${e.marketKey}`,
        list = markets.get(key) ?? [];
      list.push(e);
      markets.set(key, list);
    }
  for (const [key, list] of markets) {
    list.sort(
      (a, b) =>
        a.eventTime - b.eventTime ||
        a.ingestTime - b.ingestTime ||
        a.id.localeCompare(b.id),
    );
    markets.set(
      key,
      list.filter((e, i) => !i || e.eventTime !== list[i - 1].eventTime),
    );
  }
  const seen = new Set<string>(),
    reports: RegimeReport[] = [];
  for (const e of [...events].sort((a, b) => a.ingestTime - b.ingestTime)) {
    const r = e.payload as RegimeReport;
    if (
      e.kind !== "regime" ||
      e.source !== "nox.regime.v2" ||
      e.eventTime > asOf ||
      e.ingestTime > asOf ||
      r.decisionTime > asOf ||
      seen.has(r.id)
    )
      continue;
    seen.add(r.id);
    if (options.interval && r.interval !== options.interval) continue;
    reports.push(r);
  }
  reports.sort(
    (a, b) => a.decisionTime - b.decisionTime || a.id.localeCompare(b.id),
  );
  const nextAllowed = new Map<string, number>(),
    rows: StudyRow[] = [];
  for (const r of reports) {
    const candidates = r.venues.filter(
      (v) =>
        (!options.venue || v.marketKey.startsWith(`${options.venue}:`)) &&
        (!options.label || v.label === options.label) &&
        v.evidenceQuality.score >= (options.minQuality ?? 0) &&
        (options.concentration === "high"
          ? r.aggregates.flowConcentration != null &&
            r.aggregates.flowConcentration >= 0.5
          : options.concentration === "low"
            ? r.aggregates.flowConcentration != null &&
              r.aggregates.flowConcentration < 0.5
            : true),
    );
    const eligible = candidates.some(
      (v) => v.evidenceQuality.essentialComplete,
    );
    const overlap =
      options.purgeOverlaps !== false &&
      eligible &&
      r.decisionTime < (nextAllowed.get(r.projectId) ?? -Infinity);
    if (eligible && !overlap)
      nextAllowed.set(r.projectId, r.decisionTime + horizon);
    for (const v of candidates) {
      const row: StudyRow = {
        id: createHash("sha256")
          .update(JSON.stringify(["nox.event-study.v1", v.id, horizonMinutes]))
          .digest("hex"),
        eventId: r.id,
        projectId: r.projectId,
        marketKey: v.marketKey,
        interval: r.interval,
        label: v.label,
        decisionTime: r.decisionTime,
        horizonMinutes,
        status: "pending",
        priceReturnPct: null,
        mfePct: null,
        maePct: null,
        directionalScenarioPct: null,
        entryPrice: null,
        entryTime: null,
        samples: 0,
        largestGapMs: null,
        inputIds: [],
        missing: [],
        evidenceQuality: v.evidenceQuality.score,
        flowConcentration: r.aggregates.flowConcentration,
      };
      rows.push(row);
      if (!v.evidenceQuality.essentialComplete) {
        row.status = "suppressed";
        row.missing = ["Frozen signal failed essential quality gates"];
        continue;
      }
      if (overlap) {
        row.status = "overlap-excluded";
        row.missing = [
          "Overlaps an earlier project-event horizon in this cohort",
        ];
        continue;
      }
      const history = markets.get(`${r.projectId}:${v.marketKey}`) ?? [];
      let index = bound(history, r.decisionTime, true) - 1,
        entry: HistoryEvent | undefined;
      while (
        index >= 0 &&
        r.decisionTime - history[index].eventTime <= 90_000
      ) {
        if (
          history[index].ingestTime <= r.decisionTime &&
          history[index].projectId === r.projectId
        ) {
          entry = history[index];
          break;
        }
        index--;
      }
      if (!entry) {
        row.status = "missing-entry";
        row.missing = [
          "No observed price known within 90s before actual decision",
        ];
        continue;
      }
      row.entryPrice = price(entry);
      row.entryTime = entry.eventTime;
      row.inputIds = [entry.id];
      const end = r.decisionTime + horizon;
      if (end > asOf) {
        row.status = "pending";
        row.missing = ["Forward horizon not matured"];
        continue;
      }
      const startIndex = bound(history, r.decisionTime, true),
        endIndex = bound(history, end, true),
        path = history
          .slice(startIndex, endIndex)
          .filter((e) => e.projectId === r.projectId);
      row.samples = path.length;
      row.inputIds.push(...path.map((e) => e.id));
      row.largestGapMs = Math.max(
        0,
        ...path.map(
          (e, i) =>
            e.eventTime - (i ? path[i - 1].eventTime : entry!.eventTime),
        ),
        end - (path.at(-1)?.eventTime ?? entry.eventTime),
      );
      if (
        !path.length ||
        end - path.at(-1)!.eventTime > 90_000 ||
        row.largestGapMs > maxGap
      ) {
        row.status = "incomplete-path";
        row.missing = [
          "Price path has gaps or no endpoint within 90s before horizon",
        ];
        continue;
      }
      const returns = path.map((e) => (price(e)! / row.entryPrice! - 1) * 100);
      row.status = "complete";
      row.priceReturnPct = returns.at(-1)!;
      row.mfePct = Math.max(0, ...returns);
      row.maePct = Math.min(0, ...returns);
      const direction = /short build-up/.test(v.label)
        ? -1
        : /long build-up|short covering/.test(v.label)
          ? 1
          : null;
      row.directionalScenarioPct =
        direction == null ? null : row.priceReturnPct * direction;
    }
  }
  // Same-project venue observations are one event cluster, never independent extra trials.
  const clusters = new Map<string, StudyRow[]>();
  for (const row of rows) {
    const list = clusters.get(row.eventId) ?? [];
    list.push(row);
    clusters.set(row.eventId, list);
  }
  const complete = [...clusters.values()].filter(
    (group) => group.length > 0 && group.every((r) => r.status === "complete"),
  );
  const means = complete.map(
      (group) =>
        group.reduce((s, r) => s + r.priceReturnPct!, 0) / group.length,
    ),
    mfe = complete.map(
      (group) => group.reduce((s, r) => s + r.mfePct!, 0) / group.length,
    ),
    mae = complete.map(
      (group) => group.reduce((s, r) => s + r.maePct!, 0) / group.length,
    );
  const labels = [...new Set(rows.map((r) => r.label))];
  return {
    methodology: "nox.event-study.v1",
    asOf,
    horizonMinutes,
    rows,
    coverage: {
      candidates: rows.length,
      overlapExcluded: rows.filter((r) => r.status === "overlap-excluded")
        .length,
      suppressed: rows.filter((r) => r.status === "suppressed").length,
      pending: rows.filter((r) => r.status === "pending").length,
      completeVenues: rows.filter((r) => r.status === "complete").length,
      completeEventClusters: complete.length,
      eventClusters: clusters.size,
    },
    statistics: {
      sampleSize: complete.length,
      medianReturnPct: quantile(means, 0.5),
      q10Pct: quantile(means, 0.1),
      q90Pct: quantile(means, 0.9),
      positivePriceFrequency: means.length
        ? means.filter((v) => v > 0).length / means.length
        : null,
      medianMfePct: quantile(mfe, 0.5),
      medianMaePct: quantile(mae, 0.5),
      observedUtcDays: new Set(
        complete.map((g) =>
          new Date(g[0].decisionTime).toISOString().slice(0, 10),
        ),
      ).size,
      confidenceInterval: null,
    },
    cohorts: labels.map((label) => {
      const group = complete.filter((g) => g.every((r) => r.label === label)),
        values = group.map(
          (g) => g.reduce((s, r) => s + r.priceReturnPct!, 0) / g.length,
        );
      return {
        label,
        eventClusters: group.length,
        medianReturnPct: quantile(values, 0.5),
      };
    }),
    limitations: [
      "Descriptive Event Study, not an executable trade or calibrated historical edge.",
      options.purgeOverlaps === false
        ? "Raw outcome tracking retains overlapping events; do not treat rows as independent trials."
        : "Project-event horizons are purged within the selected cohort; remaining serial dependence is not assumed absent.",
      "Venue outcomes are equally averaged only when every cohort venue path is complete; clusters, not venues, determine sample size.",
      "Quantile range is empirical dispersion, not a confidence interval. No independent-sample confidence interval is claimed.",
      "MFE/MAE are sampled price excursions, not tick extremes. Fees, funding, spread and execution slippage are not simulated.",
      "Entry must have been known by actual decision time; later observations are used for outcomes only.",
    ],
  };
}
