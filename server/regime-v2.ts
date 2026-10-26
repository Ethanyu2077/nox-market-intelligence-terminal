import { createHash } from "node:crypto";
import type { HistoryEvent } from "../shared/history.ts";
import type { MarketProject, VenueMarketSnapshot } from "../shared/types.ts";
import type { OrderFlowResponse, FlowBucket } from "../shared/orderflow.ts";
import {
  REGIME_WINDOWS,
  type RegimeWindow,
  type VenueRegime,
  type RegimeReport,
} from "../shared/regime-v2.ts";

const MIN_BASELINE = 30;
const key = (m: { exchange: string; marketType: string; symbol: string }) =>
  `${m.exchange}:${m.marketType}:${m.symbol}`;
const id = (
  projectId: string,
  marketKey: string,
  interval: RegimeWindow,
  end: number,
) =>
  createHash("sha256")
    .update(
      JSON.stringify(["nox.regime.v2", projectId, marketKey, interval, end]),
    )
    .digest("hex");
const percent = (a: number | null, b: number | null) =>
  a != null &&
  b != null &&
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  a >= 0 &&
  b > 0
    ? (a / b - 1) * 100
    : null;
function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
}
function percentile(value: number, baseline: number[]) {
  return baseline.length >= MIN_BASELINE
    ? (100 * baseline.filter((v) => v <= value).length) / baseline.length
    : null;
}
function closedBuckets(
  buckets: FlowBucket[],
  start: number,
  end: number,
  interval: RegimeWindow,
) {
  const size = REGIME_WINDOWS[interval],
    rows = buckets.filter((b) => b.time >= start && b.time < end);
  return rows.length === 1 &&
    rows[0].time === start &&
    rows[0].complete &&
    size === end - start
    ? rows
    : [];
}
export function evaluateVenue(
  input: VenueRegime["input"],
  projectId: string,
): VenueRegime {
  const size = REGIME_WINDOWS[input.interval],
    end = Math.floor((input.decisionTime - 90_000) / size) * size,
    start = end - size,
    tolerance = Math.min(90_000, size / 4),
    marketKey = key(input.market);
  const rows = input.snapshots
    .filter(
      (e) =>
        e.marketKey === marketKey &&
        e.kind === "snapshot" &&
        e.ingestTime <= input.decisionTime &&
        e.eventTime <= input.decisionTime,
    )
    .sort(
      (a, b) =>
        a.eventTime - b.eventTime ||
        a.ingestTime - b.ingestTime ||
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
    );
  const anchor = (at: number) =>
    [...rows]
      .reverse()
      .find(
        (e) =>
          e.eventTime <= at &&
          e.eventTime >= at - tolerance &&
          !["stale", "unavailable"].includes(e.quality),
      );
  const current = anchor(end),
    previous = anchor(start),
    c = current?.payload as VenueMarketSnapshot | undefined,
    p = previous?.payload as VenueMarketSnapshot | undefined;
  const price = c && p ? percent(c.price, p.price) : null,
    oi = c && p ? percent(c.oiBase, p.oiBase) : null;
  const oiDelta =
    c?.oiBase != null && p?.oiBase != null ? c.oiBase - p.oiBase : null;
  const oiNotional =
    oiDelta != null && (c?.markPrice ?? c?.price) != null
      ? oiDelta * (c!.markPrice ?? c!.price!)
      : null;
  const baselines: { price: number; oi: number }[] = [];
  for (let n = 1; n <= 200; n++) {
    const a = anchor(start - (n - 1) * size),
      b = anchor(start - n * size),
      av = a?.payload as VenueMarketSnapshot | undefined,
      bv = b?.payload as VenueMarketSnapshot | undefined;
    if (!av || !bv) continue;
    const price = percent(av.price, bv.price),
      oi = percent(av.oiBase, bv.oiBase);
    if (price != null && oi != null)
      baselines.push({ price: Math.abs(price), oi: Math.abs(oi) });
  }
  const perp = closedBuckets(input.perpBuckets, start, end, input.interval),
    spot = closedBuckets(input.spotBuckets, start, end, input.interval);
  const delta = perp[0]?.delta ?? null,
    spotDelta =
      input.spotRequested > 0 && input.spotCovered === input.spotRequested
        ? (spot[0]?.delta ?? null)
        : null;
  const missing: string[] = [];
  if (price == null) missing.push("Price window unavailable");
  if (oi == null) missing.push("Base OI window unavailable");
  if (delta == null)
    missing.push("Complete aligned perpetual aggressor flow unavailable");
  if (baselines.length < MIN_BASELINE)
    missing.push(`Historical baseline ${baselines.length}/${MIN_BASELINE}`);
  const essential =
    price != null &&
    oi != null &&
    delta != null &&
    baselines.length >= MIN_BASELINE;
  const anomaly = essential
    ? Math.max(
        percentile(
          Math.abs(price!),
          baselines.map((b) => b.price),
        )!,
        percentile(
          Math.abs(oi!),
          baselines.map((b) => b.oi),
        )!,
      )
    : null;
  const priceThreshold =
      baselines.length >= MIN_BASELINE
        ? quantile(
            baselines.map((b) => b.price),
            0.75,
          )
        : null,
    oiThreshold =
      baselines.length >= MIN_BASELINE
        ? quantile(
            baselines.map((b) => b.oi),
            0.75,
          )
        : null;
  let label = "Insufficient evidence";
  const flowBaseline = input.perpBuckets
    .filter(
      (b) =>
        b.time < start &&
        b.complete &&
        b.delta != null &&
        Number.isFinite(b.delta),
    )
    .map((b) => Math.abs(b.delta!));
  const flowStrong =
    delta != null &&
    flowBaseline.length >= MIN_BASELINE &&
    Math.abs(delta) > quantile(flowBaseline, 0.75);
  if (essential) {
    label = "Mixed / neutral";
    const priceStrong = Math.abs(price!) > priceThreshold!,
      oiStrong = Math.abs(oi!) > oiThreshold!;
    if (priceStrong && oiStrong && oi! > 0 && price! > 0 && delta! > 0)
      label = "Potential long build-up";
    else if (priceStrong && oiStrong && oi! > 0 && price! < 0 && delta! < 0)
      label = "Potential short build-up";
    else if (priceStrong && oiStrong && oi! < 0 && price! < 0 && delta! < 0)
      label = "Potential deleveraging";
    else if (priceStrong && oiStrong && oi! < 0 && price! > 0 && delta! > 0)
      label = "Potential short covering";
    else if (!priceStrong && delta !== 0 && flowStrong)
      label = "Potential absorption";
  }
  const contradictions: string[] = [];
  if (
    spotDelta != null &&
    delta != null &&
    Math.sign(spotDelta) !== Math.sign(delta)
  )
    contradictions.push("Spot and perpetual aggressive flow disagree.");
  if (spotDelta == null) missing.push("Complete selected-spot flow");
  if (flowBaseline.length < MIN_BASELINE)
    missing.push(
      "Historical flow baseline unavailable; absorption rule disabled",
    );
  missing.push(
    "Depth / basis / verified complete liquidations are not inputs to this version",
  );
  const evidence = [
    `Closed window ${new Date(start).toISOString()} → ${new Date(end).toISOString()}`,
    `Historical baseline ${baselines.length} non-overlapping same-venue windows; prior windows only`,
    `Boundary tolerance ${tolerance / 1000}s; evidence is observed, label is inferred`,
  ];
  if (price != null) evidence.push(`Price change ${price.toFixed(4)}%`);
  if (oi != null) evidence.push(`Base OI change ${oi.toFixed(4)}%`);
  if (delta != null)
    evidence.push(`Perpetual aggressor delta ${delta.toFixed(2)} USDT`);
  const retained = new Set<string>();
  for (const e of rows)
    if (e.eventTime >= start - 201 * size - tolerance && e.eventTime <= end)
      retained.add(e.id);
  return {
    id: id(projectId, marketKey, input.interval, end),
    projectId,
    version: "nox.regime.v2",
    scope: "venue",
    marketKey,
    interval: input.interval,
    windowStart: start,
    windowEnd: end,
    decisionTime: input.decisionTime,
    label,
    anomalyScore: anomaly,
    evidenceQuality: {
      score: Math.round(
        (100 *
          [
            price != null,
            oi != null,
            delta != null,
            baselines.length >= MIN_BASELINE,
          ].filter(Boolean).length) /
          4,
      ),
      baselineSamples: baselines.length,
      essentialComplete: essential,
    },
    historicalEdge: null,
    historicalEdgeNotice:
      "Uncalibrated; no validated trading edge or success probability",
    evidence,
    contradictions,
    missing,
    metrics: {
      priceChangePct: price,
      oiChangePct: oi,
      oiDeltaBase: oiDelta,
      oiFlowNotional: oiNotional,
      perpDelta: delta,
      spotDelta,
      fundingRate: c?.fundingRate ?? null,
    },
    input: { ...input, snapshots: rows.filter((e) => retained.has(e.id)) },
  };
}
export function evaluateRegimeV2(
  project: MarketProject,
  history: HistoryEvent[],
  flow: OrderFlowResponse,
  interval: RegimeWindow,
  now = Date.now(),
): RegimeReport {
  const size = REGIME_WINDOWS[interval],
    end = Math.floor((now - 90_000) / size) * size,
    start = end - size;
  const compatible = flow.interval === interval && flow.generatedAt <= now;
  const spot = flow.aggregates.spot;
  const spotKeys = new Set(
    project.markets.filter((m) => m.marketType === "spot").map(key),
  );
  const spotRequested = spotKeys.size;
  const spotCovered = compatible
    ? flow.venues.filter(
        (v) =>
          spotKeys.has(v.key) &&
          closedBuckets(v.buckets, start, end, interval).length > 0,
      ).length
    : 0;
  const markets = [
    ...new Map(
      project.markets
        .filter((m) => m.marketType === "perpetual")
        .map((m) => [key(m), m]),
    ).values(),
  ];
  const venues = markets.map((m) =>
    evaluateVenue(
      {
        market: m,
        snapshots: history,
        perpBuckets: compatible
          ? (flow.venues.find((v) => v.key === key(m))?.buckets ?? [])
          : [],
        spotBuckets: compatible ? spot.buckets : [],
        spotRequested,
        spotCovered,
        decisionTime: now,
        interval,
      },
      project.id,
    ),
  );
  const eligible = venues.filter((v) => v.evidenceQuality.essentialComplete),
    counts = new Map<string, number>();
  for (const v of eligible) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
  const winner = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  const label =
    eligible.length < 2
      ? "Insufficient cross-exchange evidence"
      : counts.size > 1
        ? "Cross-exchange disagreement"
        : eligible.length < venues.length
          ? "Partial venue agreement"
          : winner![0];
  const supporting = winner
      ? eligible.filter((v) => v.label === winner[0]).map((v) => v.marketKey)
      : [],
    contradicting = winner
      ? eligible.filter((v) => v.label !== winner[0]).map((v) => v.marketKey)
      : [];
  const flowCovered = venues.filter((v) => v.metrics.perpDelta != null),
    oiCovered = venues.filter((v) => v.metrics.oiFlowNotional != null);
  const totalAbs = flowCovered.reduce(
      (s, v) => s + Math.abs(v.metrics.perpDelta!),
      0,
    ),
    expansion = oiCovered.reduce(
      (s, v) => s + Math.max(0, v.metrics.oiFlowNotional!),
      0,
    ),
    contraction = oiCovered.reduce(
      (s, v) => s + Math.max(0, -v.metrics.oiFlowNotional!),
      0,
    );
  const flowAttribution = venues.map((v) => ({
    marketKey: v.marketKey,
    perpDelta: v.metrics.perpDelta,
    oiFlowNotional: v.metrics.oiFlowNotional,
    absoluteFlowShare:
      v.metrics.perpDelta != null && totalAbs > 0
        ? Math.abs(v.metrics.perpDelta) / totalAbs
        : null,
    oiExpansionShare:
      v.metrics.oiFlowNotional != null && expansion > 0
        ? Math.max(0, v.metrics.oiFlowNotional) / expansion
        : null,
    oiContractionShare:
      v.metrics.oiFlowNotional != null && contraction > 0
        ? Math.max(0, -v.metrics.oiFlowNotional) / contraction
        : null,
  }));
  const sumFlow = flowCovered.length
      ? flowCovered.reduce((s, v) => s + v.metrics.perpDelta!, 0)
      : null,
    sumOi = oiCovered.length
      ? oiCovered.reduce((s, v) => s + v.metrics.oiFlowNotional!, 0)
      : null;
  const spotBucket = compatible
    ? closedBuckets(spot.buckets, start, end, interval)[0]
    : undefined;
  return {
    id: id(project.id, "aggregated", interval, end),
    projectId: project.id,
    version: "nox.regime.v2",
    scope: "aggregated",
    interval,
    windowStart: start,
    windowEnd: end,
    decisionTime: now,
    label,
    requestedVenues: venues.length,
    coveredVenues: eligible.length,
    supporting,
    contradicting,
    missingVenues: venues
      .filter((v) => !v.evidenceQuality.essentialComplete)
      .map((v) => v.marketKey),
    anomalyScore: eligible.length
      ? Math.max(...eligible.map((v) => v.anomalyScore!))
      : null,
    evidenceQuality: venues.length
      ? Math.round((100 * eligible.length) / venues.length)
      : 0,
    historicalEdge: null,
    venues,
    flowAttribution,
    aggregates: {
      perpDelta:
        venues.length && flowCovered.length === venues.length ? sumFlow : null,
      oiFlowNotional:
        venues.length && oiCovered.length === venues.length ? sumOi : null,
      coveredPerpDelta: sumFlow,
      coveredOiFlowNotional: sumOi,
      flowConcentration:
        totalAbs > 0
          ? flowAttribution.reduce(
              (s, v) => s + (v.absoluteFlowShare ?? 0) ** 2,
              0,
            )
          : null,
      spotDelta:
        spotRequested > 0 && spotCovered === spotRequested
          ? (spotBucket?.delta ?? null)
          : null,
      spotRequested,
      spotCovered,
    },
    notice:
      "Observed inputs; inferred structures. Contributions cover returned venues only; not a causal lead-lag result. Scores are not probabilities. Historical edge unavailable.",
  };
}
