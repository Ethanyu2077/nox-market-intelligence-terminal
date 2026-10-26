import type { MarketProject, VenueMarketSnapshot } from "../shared/types.ts";
import type { HistoryEvent } from "../shared/history.ts";
import type { OrderFlowResponse } from "../shared/orderflow.ts";
import type { RegimeReport, RegimeWindow } from "../shared/regime-v2.ts";
import { evaluateRegimeV2 } from "./regime-v2.ts";
import { orderFlowCapability } from "./orderflow-adapters.ts";

export function weightedConsensus(report: RegimeReport) {
  const weights = report.venues.map((v) => {
    const end = [...v.input.snapshots]
      .filter(
        (e) =>
          e.marketKey === v.marketKey &&
          e.eventTime <= report.windowEnd &&
          report.windowEnd - e.eventTime <= 90_000 &&
          e.ingestTime <= report.decisionTime &&
          !["stale", "unavailable"].includes(e.quality),
      )
      .sort(
        (a, b) => b.eventTime - a.eventTime || a.ingestTime - b.ingestTime,
      )[0];
    const snapshot = end?.payload as VenueMarketSnapshot | undefined,
      comparable = v.input.market.quote === "USDT";
    const positive = (value: number | null | undefined) =>
      comparable && value != null && Number.isFinite(value) && value >= 0
        ? value
        : null;
    return {
      marketKey: v.marketKey,
      label: v.label,
      eligible: v.evidenceQuality.essentialComplete,
      oiUsd: positive(snapshot?.oiUsd),
      volume24hUsd: positive(snapshot?.volume24hUsd),
      sourceTime: end?.eventTime ?? null,
    };
  });
  const calculate = (metric: "oiUsd" | "volume24hUsd") => {
    const known = weights.filter((w) => w[metric] != null),
      total = known.reduce((s, w) => s + w[metric]!, 0),
      groups = new Map<string, number>();
    for (const w of known) {
      const label = w.eligible ? w.label : "Insufficient evidence";
      groups.set(label, (groups.get(label) ?? 0) + w[metric]!);
    }
    const distribution = [...groups]
      .map(([label, value]) => ({
        label,
        weightShare: total > 0 ? value / total : null,
      }))
      .sort(
        (a, b) =>
          (b.weightShare ?? 0) - (a.weightShare ?? 0) ||
          a.label.localeCompare(b.label),
      );
    return {
      metric,
      requested: weights.length,
      known: known.length,
      missing: weights.filter((w) => w[metric] == null).map((w) => w.marketKey),
      knownWeightTotal: known.length ? total : null,
      complete:
        known.length === weights.length &&
        known.every((w) => w.eligible) &&
        weights.length > 0 &&
        total > 0,
      dominantLabel: total > 0 ? distribution[0]?.label ?? null : null,
      distribution,
      venueWeights: weights.map((w) => ({
        marketKey: w.marketKey,
        value: w[metric],
        share: w[metric] != null && total > 0 ? w[metric]! / total : null,
      })),
    };
  };
  return {
    eventId: report.id,
    decisionTime: report.decisionTime,
    countBased: report.label,
    oi: calculate("oiUsd"),
    volume: calculate("volume24hUsd"),
    notice:
      "Separate exposure distributions over known weights; unavailable venues are not assigned zero. 24h volume is a rolling snapshot, not volume of the regime window. Not a probability or causal leadership claim.",
  };
}
export function signalReadiness(
  project: MarketProject,
  history: HistoryEvent[],
  recent: HistoryEvent[],
  flow: OrderFlowResponse,
  interval: RegimeWindow,
  now: number,
) {
  const analysis = evaluateRegimeV2(project, history, flow, interval, now);
  const paused =
    project.archived ||
    !project.monitoring.streamingEnabled ||
    project.monitoring.collectionMode === "paused";
  return {
    projectId: project.id,
    interval,
    checkedAt: now,
    mode: project.monitoring.collectionMode ?? "standard",
    venues: analysis.venues.map((v) => {
      const market = project.markets.find(
        (m) => `${m.exchange}:${m.marketType}:${m.symbol}` === v.marketKey,
      )!;
      const capability = orderFlowCapability(market),
        feed = flow.venues.find((f) => f.key === v.marketKey);
      const latest = recent
          .filter(
            (e) =>
              e.marketKey === v.marketKey &&
              e.eventTime <= now &&
              e.ingestTime <= now,
          )
          .sort((a, b) => b.eventTime - a.eventTime)[0],
        snapshot = latest?.payload as VenueMarketSnapshot | undefined;
      const snapshotAgeMs = latest ? now - latest.eventTime : null,
        checkAgeMs = feed?.checkedAt != null ? now - feed.checkedAt : null;
      const fresh =
          latest != null &&
          snapshotAgeMs! <= 90_000 &&
          !["stale", "unavailable"].includes(latest.quality),
        continuous = v.metrics.perpDelta != null;
      const flowFresh =
        checkAgeMs != null &&
        checkAgeMs <= 30_000 &&
        !["stale", "unavailable"].includes(feed?.state ?? "unavailable");
      const state = paused
        ? "paused"
        : !capability.available
          ? "unsupported"
          : !fresh || (feed?.checkedAt != null && !flowFresh)
            ? "stale"
            : !v.evidenceQuality.essentialComplete || !flowFresh
              ? "warming"
              : "ready";
      return {
        marketKey: v.marketKey,
        state,
        baselineSamples: v.evidenceQuality.baselineSamples,
        requiredSamples: 30,
        remainingSamples: Math.max(0, 30 - v.evidenceQuality.baselineSamples),
        snapshotAgeMs,
        flowCheckAgeMs: checkAgeMs,
        flowFresh,
        flowState: feed?.state ?? "unavailable",
        flowContinuous: continuous,
        gapCount: feed?.gaps.length ?? null,
        flowSupported: capability.available,
        supportedReason: capability.reason,
        availableAnalysis: {
          price: snapshot?.price != null,
          oi: snapshot?.oiBase != null,
          funding: snapshot?.fundingRate != null,
        },
        suppressionReasons: [
          ...v.missing,
          ...(!fresh ? ["Latest snapshot is stale or missing"] : []),
          ...(!flowFresh ? ["Current aggressor feed is not fresh"] : []),
          ...(paused ? ["Collection is paused"] : []),
        ],
      };
    }),
    notice:
      "Readiness means evidence availability, not a profitable signal. Quality gates are unchanged.",
  };
}
