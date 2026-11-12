import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { eventStudy } from "../server/event-study.ts";
import {
  weightedConsensus,
  signalReadiness,
} from "../server/research-readiness.ts";
import { OutcomeStore } from "../server/outcome-store.ts";
import { HistoryStore } from "../server/history-store.ts";
import type { RegimeReport } from "../shared/regime-v2.ts";
import type { HistoryEvent } from "../shared/history.ts";
import type { MarketProject } from "../shared/types.ts";
import type { OrderFlowResponse } from "../shared/orderflow.ts";

const decision = Math.floor(Date.now() / 86_400_000) * 86_400_000,
  key = "binance:perpetual:TESTUSDT";
function snapshot(time: number, value = 100, marketKey = key): HistoryEvent {
  return {
    id: `${marketKey}:${time}:${value}`,
    kind: "snapshot",
    marketKey,
    projectId: "p",
    eventTime: time,
    ingestTime: time,
    source: "test",
    quality: "live",
    payload: { price: value, oiUsd: 100, volume24hUsd: 200 },
  };
}
function signal(id = "event", time = decision, venues = [key]): HistoryEvent {
  const report = {
    id,
    projectId: "p",
    version: "nox.regime.v2",
    interval: "5m",
    decisionTime: time,
    windowEnd: time - 90_000,
    label: "Potential long build-up",
    aggregates: { flowConcentration: 0.7 },
    venues: venues.map((marketKey) => ({
      id: `${id}:${marketKey}`,
      projectId: "p",
      marketKey,
      interval: "5m",
      label: "Potential long build-up",
      evidenceQuality: {
        score: 100,
        baselineSamples: 40,
        essentialComplete: true,
      },
      input: {
        market: { quote: "USDT" },
        snapshots: [snapshot(time - 90_000, 100, marketKey)],
      },
    })),
  } as RegimeReport;
  return {
    id,
    kind: "regime",
    marketKey: "*",
    projectId: "p",
    eventTime: time,
    ingestTime: time,
    source: "nox.regime.v2",
    quality: "live",
    payload: report,
  };
}
const prices = (minutes = 15, marketKey = key) =>
  Array.from({ length: minutes + 1 }, (_, i) =>
    snapshot(decision + i * 60_000, 100 + i, marketKey),
  );
test("event study uses actual decision entry, not window close, and rejects late-known entry", () => {
  const old = snapshot(decision - 90_000, 50),
    data = prices();
  let r = eventStudy([signal()], [old, ...data], {
    horizonMinutes: 15,
    asOf: decision + 900_000,
  });
  assert.equal(r.rows[0].entryPrice, 100);
  assert.ok(Math.abs(r.rows[0].priceReturnPct! - 15) < 1e-8);
  data[0].ingestTime = decision + 1;
  r = eventStudy([signal()], data, {
    horizonMinutes: 15,
    asOf: decision + 900_000,
  });
  assert.equal(r.rows[0].status, "missing-entry");
  assert.equal(r.statistics.medianReturnPct, null);
});
test("all four horizons mature independently and future data is not used", () => {
  for (const horizonMinutes of [15, 60, 240, 1440] as const) {
    const r = eventStudy([signal()], prices(horizonMinutes), {
      horizonMinutes,
      asOf: decision + horizonMinutes * 60_000,
    });
    assert.equal(r.rows[0].status, "complete");
    const pending = eventStudy([signal()], prices(horizonMinutes), {
      horizonMinutes,
      asOf: decision + horizonMinutes * 60_000 - 1,
    });
    assert.equal(pending.rows[0].status, "pending");
    assert.equal(pending.rows[0].priceReturnPct, null);
  }
});
test("gaps suppress outcomes, while observed flat prices produce genuine zero", () => {
  const options = { horizonMinutes: 15 as const, asOf: decision + 900_000 };
  const gap = eventStudy(
    [signal()],
    [snapshot(decision), snapshot(decision + 900_000, 110)],
    options,
  );
  assert.equal(gap.rows[0].status, "incomplete-path");
  assert.equal(gap.rows[0].mfePct, null);
  const flat = eventStudy(
    [signal()],
    prices().map((e) => ({ ...e, payload: { price: 100 } })),
    options,
  );
  assert.equal(flat.rows[0].priceReturnPct, 0);
  assert.equal(flat.statistics.positivePriceFrequency, 0);
});
test("same event venues are one sample and overlapping project events are purged", () => {
  const other = "bybit:perpetual:TESTUSDT",
    a = signal("a", decision, [key, other]),
    b = signal("b", decision + 300_000, [key, other]);
  const r = eventStudy([a, a, b], [...prices(20), ...prices(20, other)], {
    horizonMinutes: 15,
    asOf: decision + 1_200_000,
  });
  assert.equal(r.coverage.candidates, 4);
  assert.equal(r.coverage.overlapExcluded, 2);
  assert.equal(r.statistics.sampleSize, 1);
  assert.equal(r.coverage.completeVenues, 2);
});
test("failed frozen gates never become valid outcomes or affect overlap selection", () => {
  const failed = signal("bad");
  (failed.payload as RegimeReport).venues[0].evidenceQuality.essentialComplete =
    false;
  const r = eventStudy(
    [failed, signal("good", decision + 60_000)],
    prices(16),
    { horizonMinutes: 15, asOf: decision + 960_000 },
  );
  assert.equal(r.coverage.suppressed, 1);
  assert.equal(r.coverage.overlapExcluded, 0);
  assert.equal(r.rows[0].priceReturnPct, null);
  assert.equal(r.rows[1].status, "complete");
});
test("cohort filters and observation cutoff apply before evaluation", () => {
  const e = signal();
  const future = { ...signal("future"), eventTime: decision + 1_000_000 };
  assert.equal(
    eventStudy([e, future], prices(), {
      horizonMinutes: 15,
      asOf: decision + 900_000,
      concentration: "high",
    }).rows.length,
    1,
  );
  assert.equal(
    eventStudy([e], prices(), {
      horizonMinutes: 15,
      asOf: decision + 900_000,
      concentration: "low",
    }).rows.length,
    0,
  );
  assert.equal(
    eventStudy([e], prices(), {
      horizonMinutes: 15,
      asOf: decision + 900_000,
      venue: "okx",
    }).rows.length,
    0,
  );
});
test("weights preserve count consensus, distinguish unknown from zero, and exclude future inputs", () => {
  const r = signal("weights", decision, [key, "bybit:perpetual:TESTUSDT"])
    .payload as RegimeReport;
  r.label = "Cross-exchange disagreement";
  r.venues[1].label = "Potential short build-up";
  r.venues[1].input.snapshots[0].payload = { oiUsd: 900, volume24hUsd: null };
  let w = weightedConsensus(r);
  assert.equal(w.countBased, r.label);
  assert.equal(w.oi.dominantLabel, "Potential short build-up");
  assert.equal(w.oi.distribution[0].weightShare, 0.9);
  assert.equal(w.volume.complete, false);
  assert.equal(w.volume.venueWeights[1].value, null);
  r.venues[1].input.snapshots[0].ingestTime = decision + 1;
  w = weightedConsensus(r);
  assert.equal(w.oi.known, 1);
  r.venues[0].input.snapshots[0].payload = { oiUsd: 0 };
  w = weightedConsensus(r);
  assert.equal(w.oi.knownWeightTotal, 0);
  assert.equal(w.oi.distribution[0].weightShare, null);
  assert.equal(w.oi.complete, false);
});
test("derived outcomes version independently and deduplicate across restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-outcome-"));
  const input = signal(),
    frozen = JSON.stringify(input);
  const pending = eventStudy([input], prices(), {
    horizonMinutes: 15,
    asOf: decision + 60_000,
  });
  let store = new OutcomeStore(dir);
  assert.equal(await store.record(pending), 1);
  await store.close();
  store = new OutcomeStore(dir);
  assert.equal(await store.record(pending), 0);
  const complete = eventStudy([input], prices(), {
    horizonMinutes: 15,
    asOf: decision + 900_000,
  });
  assert.equal(await store.record(complete), 1);
  await store.close();
  const files = (await readdir(path.join(dir, "outcomes"))).filter((f) =>
    f.endsWith(".ndjson"),
  );
  const lines = (await readFile(path.join(dir, "outcomes", files[0]), "utf8"))
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
  assert.notEqual(JSON.parse(lines[0]).revision, JSON.parse(lines[1]).revision);
  assert.equal(JSON.stringify(input), frozen);
});
test("unchanged outcomes leave the journal and checkpoint untouched; recovery repairs a torn append", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-outcome-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const study = eventStudy([signal()], prices(), { horizonMinutes: 15, asOf: decision + 900_000 });
  const two = { ...study, rows: [study.rows[0], { ...study.rows[0], id: "second" }] };
  let store = new OutcomeStore(dir);
  assert.equal(await store.record(two), 2);
  const outcomes = path.join(dir, "outcomes");
  const file = path.join(outcomes, new Date(two.asOf).toISOString().slice(0, 10) + ".ndjson");
  const checkpoint = path.join(outcomes, "revision-checkpoint.json.gz");
  const info = async (p: string) => {
    const s = await stat(p, { bigint: true });
    return [s.size, s.ino, s.mtimeNs];
  };
  const original = await Promise.all([info(file), info(checkpoint)]);
  assert.deepEqual(await Promise.all([store.record(two), store.record(two)]), [0, 0]);
  assert.deepEqual(await Promise.all([info(file), info(checkpoint)]), original);
  const changed = { ...two, rows: two.rows.map(row => ({ ...row, label: "changed" })) };
  assert.equal(await store.record(changed), 2);
  assert.deepEqual(await info(checkpoint), original[1]);
  await store.close();
  const complete = await readFile(file);
  await appendFile(file, '{"id":"unfinished');
  store = new OutcomeStore(dir);
  assert.equal(await store.record(changed), 0);
  assert.deepEqual(await readFile(file), complete);
  const tomorrow = { ...changed, asOf: changed.asOf + 86_400_000, rows: study.rows };
  assert.equal(await store.record(tomorrow), 1);
  await store.close();
  store = new OutcomeStore(dir);
  assert.equal(await store.record(tomorrow), 0);
  await store.close();
});

test("imports an existing revision index and can rebuild from sealed outcome partitions", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-outcome-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = path.join(dir, "outcomes");
  await mkdir(directory);
  const study = eventStudy([signal()], prices(), { horizonMinutes: 15, asOf: decision + 900_000 });
  const row = study.rows[0];
  const revision = createHash("sha256").update(JSON.stringify([study.methodology, row])).digest("hex");
  const day = new Date(study.asOf).toISOString().slice(0, 10);
  const line = JSON.stringify({ id: row.id, revision, methodology: study.methodology, asOf: study.asOf, row }) + "\n";
  const archive = path.join(directory, `${day}.ndjson.1-2-${randomUUID()}.${Buffer.byteLength(line)}.x.x.gz`);
  await writeFile(archive, gzipSync(line));
  let store = new OutcomeStore(dir);
  assert.equal(await store.record(study), 0);
  await store.close();
  const legacy = path.join(directory, "revision-index.json");
  await writeFile(legacy, JSON.stringify({ [`${study.methodology}:${row.id}`]: revision }));
  store = new OutcomeStore(dir);
  assert.equal(await store.record(study), 0);
  const updated = { ...study, rows: [{ ...row, label: "new label" }] };
  assert.equal(await store.record(updated), 1);
  await store.close();
  await assert.rejects(stat(legacy), { code: "ENOENT" });
  store = new OutcomeStore(dir);
  assert.equal(await store.record(updated), 0);
  await store.close();
});

test("a disk-full checkpoint write frees the partial file and retains the old index for retry", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-outcome-full-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = path.join(dir, "outcomes");
  await mkdir(directory);
  const index = path.join(directory, "revision-index.json");
  await writeFile(index, "{}");
  const handle = await open(index, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const write = prototype.writeFile;
  const failure = t.mock.method(prototype, "writeFile", async function (this: FileHandle) {
    await write.call(this, "partial");
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  const store = new OutcomeStore(dir);
  const study = eventStudy([signal()], prices(), { horizonMinutes: 15, asOf: decision + 900_000 });
  await assert.rejects(store.record(study), { code: "ENOSPC" });
  failure.mock.restore();
  assert.deepEqual(await readdir(directory), ["revision-index.json"]);
  assert.equal(await readFile(index, "utf8"), "{}");
  assert.equal(await store.record(study), 1);
  await store.close();
  const restarted = new OutcomeStore(dir);
  assert.equal(await restarted.record(study), 0);
  await restarted.close();
});

test("history research projection filters source and interval without changing frozen payload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-study-history-")),
    store = new HistoryStore(dir);
  await store.init();
  try {
    const e = signal();
    await store.append(e);
    await store.append({ ...signal("legacy"), source: "legacy" });
    await store.append(snapshot(decision));
    const page = await store.page("p", {
      kind: "regime",
      source: "nox.regime.v2",
      regimeInterval: "5m",
      summarizeRegime: true,
      asOf: decision + 1,
    });
    assert.equal(page.items.length, 1);
    assert.equal(
      (page.items[0].payload as RegimeReport).venues[0].input.snapshots.length,
      0,
    );
    const full = await store.page("p", {
      kind: "regime",
      id: e.id,
      asOf: decision + 1,
    });
    assert.equal(
      (full.items[0].payload as RegimeReport).venues[0].input.snapshots.length,
      1,
    );
    const thin = await store.page("p", {
      kind: "snapshot",
      priceOnly: true,
      asOf: decision + 1,
    });
    assert.deepEqual(thin.items[0].payload, { price: 100 });
  } finally {
    await store.close();
  }
});
test("readiness explains missing baseline and keeps paused collection suppressed", () => {
  const market = {
    exchange: "binance",
    marketType: "perpetual",
    symbol: "TESTUSDT",
    base: "TEST",
    quote: "USDT",
  };
  const p = {
    id: "p",
    markets: [market],
    monitoring: { streamingEnabled: true, collectionMode: "standard" },
  } as MarketProject;
  const flow = {
    projectId: "p",
    interval: "5m",
    generatedAt: decision,
    venues: [],
    aggregates: { spot: { requested: 0, covered: 0, buckets: [], keys: [] } },
  } as unknown as OrderFlowResponse;
  let r = signalReadiness(p, [], [snapshot(decision)], flow, "5m", decision);
  assert.equal(r.venues[0].state, "warming");
  assert.equal(r.venues[0].remainingSamples, 30);
  p.monitoring.collectionMode = "paused";
  r = signalReadiness(p, [], [], flow, "5m", decision);
  assert.equal(r.venues[0].state, "paused");
  assert.ok(r.venues[0].suppressionReasons.includes("Collection is paused"));
});
