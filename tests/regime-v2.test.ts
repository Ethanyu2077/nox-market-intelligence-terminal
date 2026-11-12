import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { evaluateRegimeV2, evaluateVenue } from "../server/regime-v2.ts";
import { RegimeRecorder } from "../server/regime-recorder.ts";
import { ProjectCollector } from "../server/collector.ts";
import { OrderFlowService } from "../server/orderflow-service.ts";
import { HistoryStore, type HistoryEvent } from "../server/history-store.ts";
import { REGIME_WINDOWS, type RegimeWindow } from "../shared/regime-v2.ts";
import type {
  MarketProject,
  ProjectMarket,
  VenueMarketSnapshot,
} from "../shared/types.ts";
import type { OrderFlowResponse, FlowBucket } from "../shared/orderflow.ts";

const market = (exchange = "binance") =>
  ({
    id: exchange,
    exchange,
    marketType: "perpetual",
    symbol: "TESTUSDT",
    base: "TEST",
    quote: "USDT",
    status: "TRADING",
  }) as ProjectMarket;
const project = (exchanges = ["binance", "bybit"]) =>
  ({ id: "p", markets: exchanges.map(market) }) as MarketProject;
const bucket = (time: number, delta = 100, complete = true): FlowBucket => ({
  time,
  buy: delta > 0 ? delta : 0,
  sell: delta < 0 ? -delta : 0,
  delta,
  cvd: delta,
  base: Math.abs(delta),
  buyBase: delta > 0 ? delta : 0,
  sellBase: delta < 0 ? -delta : 0,
  vwap: 1,
  high: 1,
  low: 1,
  maxTradeNotional: Math.abs(delta),
  complete,
  count: 1,
  zScore: null,
  reset: false,
});
function fixture(
  interval: RegimeWindow = "5m",
  exchanges = ["binance", "bybit"],
) {
  const size = REGIME_WINDOWS[interval],
    end = Math.floor((Date.now() - 90_000) / size) * size,
    now = end + 90_000;
  const history: HistoryEvent[] = [];
  for (const exchange of exchanges)
    for (let i = 40; i >= 0; i--) {
      const time = end - i * size;
      history.push({
        id: `${exchange}:${time}`,
        kind: "snapshot",
        marketKey: `${exchange}:perpetual:TESTUSDT`,
        projectId: "p",
        eventTime: time,
        ingestTime: time,
        source: "fixture",
        quality: "live",
        payload: {
          price: i ? 100 + i * 0.01 : 105,
          markPrice: i ? 100 + i * 0.01 : 105,
          oiBase: i ? 100 + i * 0.01 : 110,
          fundingRate: null,
          marketType: "perpetual",
        } as VenueMarketSnapshot,
      });
    }
  const flow = {
    projectId: "p",
    interval,
    generatedAt: now,
    venues: exchanges.map((exchange) => ({
      key: `${exchange}:perpetual:TESTUSDT`,
      buckets: [bucket(end - size)],
    })),
    aggregates: { spot: { requested: 0, covered: 0, buckets: [], keys: [] } },
  } as unknown as OrderFlowResponse;
  return { history, flow, now, end };
}
test("stable event IDs do not change with re-evaluation time inside a closed-window period", () => {
  const f = fixture(),
    a = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now),
    b = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now + 20_000);
  assert.equal(a.id, b.id);
  assert.equal(a.venues[0].id, b.venues[0].id);
  assert.notEqual(a.id, a.venues[0].id);
});
test("all four intervals use project/venue history rather than fixed global thresholds", () => {
  for (const interval of Object.keys(REGIME_WINDOWS) as RegimeWindow[]) {
    const f = fixture(interval),
      r = evaluateRegimeV2(project(), f.history, f.flow, interval, f.now);
    assert.equal(r.label, "Potential long build-up");
    assert.ok(r.venues.every((v) => v.evidenceQuality.baselineSamples >= 30));
    assert.equal(r.historicalEdge, null);
  }
});
test("insufficient baseline or partial aggressor flow suppresses classification", () => {
  const f = fixture();
  const short = evaluateRegimeV2(
    project(),
    f.history.slice(-5),
    f.flow,
    "5m",
    f.now,
  );
  assert.equal(short.coveredVenues, 0);
  assert.equal(short.anomalyScore, null);
  f.flow.venues[0].buckets[0].complete = false;
  const partial = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
  assert.equal(partial.venues[0].label, "Insufficient evidence");
  assert.equal(partial.aggregates.perpDelta, null);
  assert.equal(partial.aggregates.coveredPerpDelta, 100);
});
test("venue disagreement is not forced into a global directional regime", () => {
  const f = fixture();
  (
    f.history.find((e) => e.id === `bybit:${f.end}`)!
      .payload as VenueMarketSnapshot
  ).price = 95;
  f.flow.venues[1].buckets[0].delta = -100;
  const r = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
  assert.equal(r.label, "Cross-exchange disagreement");
  assert.equal(r.contradicting.length, 1);
  assert.equal(r.supporting.length, 1);
  assert.equal(r.coveredVenues, 2);
});
test("snapshot availability and future event times exclude lookahead; frozen inputs reproduce exactly", () => {
  const f = fixture();
  const r = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
  assert.deepEqual(evaluateVenue(r.venues[0].input, "p"), r.venues[0]);
  f.history.find((e) => e.id === `binance:${f.end}`)!.ingestTime = f.now + 1000;
  const blocked = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
  assert.equal(blocked.venues[0].label, "Insufficient evidence");
});
test("flow attribution uses base OI expansion not price-sensitive USD OI change", () => {
  const f = fixture();
  const current = f.history.find((e) => e.id === `binance:${f.end}`)!
    .payload as VenueMarketSnapshot;
  current.oiBase = 100.01;
  const r = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
  assert.equal(r.flowAttribution[0].oiFlowNotional, 0);
  assert.equal(r.flowAttribution[0].oiExpansionShare, 0);
  assert.equal(r.aggregates.flowConcentration, 0.5);
});
test("flow from wrong intervals, future captures or missing venues is not silently aggregated", () => {
  const f = fixture();
  f.flow.interval = "15m";
  const r = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
  assert.equal(r.aggregates.perpDelta, null);
  assert.equal(r.coveredVenues, 0);
  f.flow.interval = "5m";
  f.flow.generatedAt = f.now + 1;
  assert.equal(
    evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now).coveredVenues,
    0,
  );
});
test("same project history can be sampled across long windows without newest-N truncation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-adaptive-")),
    store = new HistoryStore(dir);
  await store.init();
  try {
    const f = fixture("4h", ["binance"]);
    for (const e of f.history) await store.append(e);
    const samples = await store.sampleSnapshots(
      "p",
      REGIME_WINDOWS["4h"],
      f.now,
    );
    assert.equal(samples.length, 41);
    assert.ok(
      evaluateRegimeV2(project(["binance"]), samples, f.flow, "4h", f.now)
        .venues[0].evidenceQuality.essentialComplete,
    );
  } finally {
    await store.close();
  }
});
test("recorder freezes first input set and deduplicates across restarts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-event-")),
    history = new HistoryStore(dir);
  await history.init();
  try {
    const f = fixture(),
      report = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
    let recorder = new RegimeRecorder(dir, history);
    assert.equal(await recorder.record(report), true);
    report.label = "changed";
    assert.equal(await recorder.record(report), false);
    recorder = new RegimeRecorder(dir, history);
    assert.equal(await recorder.record(report), false);
    const saved = await history.read("p", "regime");
    assert.equal(saved.length, 1);
    assert.notEqual((saved[0].payload as { label: string }).label, "changed");
  } finally {
    await history.close();
  }
});

test("multiple projects and windows share one progress write and recover before that write", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-regime-batched-"));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const history = new HistoryStore(dir), hints = path.join(dir,"regime-v2-windows.json");
  await history.init();
  try {
    const worker = new RegimeRecorder(dir,history);
    const reports = ["p","q"].map(id => (Object.keys(REGIME_WINDOWS) as RegimeWindow[]).map(interval => {
      const f = fixture(interval);
      return evaluateRegimeV2({...project(), id}, f.history, f.flow, interval, f.now);
    }));
    for (const batch of reports) assert.equal(await worker.recordBatch(batch), 4);
    await assert.rejects(readFile(hints), {code:"ENOENT"});

    // Restart after the journals were written but before the collector flushed their hints.
    const recovered = new RegimeRecorder(dir,history);
    for (const batch of reports) await recovered.recordBatch(batch.map(r => ({...r,label:"later evaluation"})));
    await recovered.flush();
    assert.equal(Object.keys(JSON.parse(await readFile(hints,"utf8"))).length, 8);
    for (const id of ["p","q"]) {
      const rows = await history.read(id,"regime");
      assert.equal(rows.length,4);
      assert.ok(rows.every(row => (row.payload as {label:string}).label !== "later evaluation"));
    }
    const before = await stat(hints);
    assert.equal(await recovered.recordBatch(reports.flat()), 0);
    await recovered.flush();
    assert.equal((await stat(hints)).ino, before.ino);
  } finally { await history.close(); }
});

test("an offline restart preserves an uncached frozen decision and admits new windows", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-regime-recovery-"));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const boundary = Math.floor(Date.now() / REGIME_WINDOWS["15m"]) * REGIME_WINDOWS["15m"];
  t.mock.method(Date, "now", () => boundary + 1_000);
  const f = fixture(), report = evaluateRegimeV2(project(), f.history, f.flow,"5m",f.now);
  const g = fixture("15m");
  const fresh = evaluateRegimeV2(project(), g.history, g.flow, "15m", boundary + 90_000);
  const ids = new Set<string>();
  let connected = false;
  const history = {
    page: async (_project:string, query:{id:string}) => ({
      fallback: connected ? null : "Database connection lost",
      items: (connected && query.id === report.id) || ids.has(query.id) ? [{id:query.id}] : [],
    }),
    append: async ({id}:HistoryEvent) => { assert.notEqual(id, report.id); ids.add(id); },
  } as unknown as HistoryStore;
  const recorder = new RegimeRecorder(dir,history);
  await assert.rejects(recorder.recordBatch([{...report, label:"later evaluation"}, fresh]), /verify/);
  await recorder.flush();
  assert.deepEqual([...ids], [fresh.id]);
  assert.equal(await recorder.isRecorded(fresh.projectId, fresh.interval, fresh.windowEnd), true);
  assert.equal(await recorder.isRecorded(report.projectId, report.interval, report.windowEnd), false);
  connected = true;
  assert.equal(await recorder.record(report), true);
  assert.deepEqual([...ids], [fresh.id]);
});

test("a partially failed batch recovers durable reports by ID before advancing hints", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-regime-partial-"));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const reports = (["5m","15m"] as const).map(interval => {
    const f = fixture(interval);
    return evaluateRegimeV2(project(), f.history, f.flow, interval, f.now);
  });
  const ids = new Set<string>();
  let fail = true;
  const history = {
    page: async (_project:string, query:{id:string}) => ({items:ids.has(query.id) ? [{id:query.id}] : []}),
    append: async ({id}:HistoryEvent) => {
      if (fail && id === reports[1].id) throw new Error("write failed");
      assert.ok(!ids.has(id));
      ids.add(id);
    },
  } as unknown as HistoryStore;
  const recorder = new RegimeRecorder(dir,history);
  await assert.rejects(recorder.recordBatch(reports), /write failed/);
  await recorder.flush();
  await assert.rejects(stat(path.join(dir,"regime-v2-windows.json")), {code:"ENOENT"});
  assert.equal(ids.size,1);
  fail = false;
  assert.equal(await recorder.recordBatch(reports),2);
  await recorder.flush();
  const recovered = new RegimeRecorder(dir,history);
  assert.equal(await recovered.recordBatch(reports),0);
  assert.equal(ids.size,2);
});

test("collector removes deleted-project window hints on restart and preserves archived projects and reports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-regime-index-"));
  const file = path.join(dir, "regime-v2-windows.json");
  const history = new HistoryStore(dir);
  await history.init();
  const flow = new OrderFlowService(dir);
  const retained = { ...project(), id: "retained", archived: true };
  const worker = new ProjectCollector(() => [retained], flow, history, undefined, new RegimeRecorder(dir, history));
  try {
    const f = fixture();
    const report = evaluateRegimeV2(project(), f.history, f.flow, "5m", f.now);
    await new RegimeRecorder(dir, history).record(report);
    const hints = JSON.parse(await readFile(file, "utf8"));
    hints["retained:5m"] = report.windowEnd;
    for (let i = 0; i < 3000; i++) hints[`obsolete-${i}:1h`] = report.windowEnd;
    await writeFile(file, JSON.stringify(hints));
    const before = await stat(file);
    await worker.tick();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { "retained:5m": report.windowEnd });
    assert.equal((await history.read("p", "regime")).length, 1);
    const compact = await stat(file);
    assert.ok(compact.size < before.size / 100);
    await worker.tick();
    assert.equal((await stat(file)).ino, compact.ino);
  } finally {
    await worker.close();
    await flow.close();
    await history.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same current price/OI move is treated differently against a high-volatility local baseline',()=>{
  const f=fixture(),low=evaluateRegimeV2(project(),f.history,f.flow,'5m',f.now);
  for(const e of f.history)if(e.eventTime<f.end-REGIME_WINDOWS['5m']){const p=e.payload as VenueMarketSnapshot;const high=Math.floor(e.eventTime/REGIME_WINDOWS['5m'])%2===0;p.price=high?150:50;p.oiBase=high?150:50;}
  const high=evaluateRegimeV2(project(),f.history,f.flow,'5m',f.now);
  assert.equal(low.venues[0].metrics.priceChangePct,high.venues[0].metrics.priceChangePct);
  assert.equal(low.venues[0].metrics.oiChangePct,high.venues[0].metrics.oiChangePct);
  assert.equal(low.label,'Potential long build-up');assert.notEqual(high.label,'Potential long build-up');
});
test('spot contradiction requires selected, complete, aligned venue evidence',()=>{
  const f=fixture(),p=project();p.markets.push({...market('bitget'),marketType:'spot'});
  const spotVenue={key:'bitget:spot:TESTUSDT',buckets:[bucket(f.end-REGIME_WINDOWS['5m'],-100)]};
  f.flow.venues.push(spotVenue as OrderFlowResponse['venues'][number]);
  f.flow.aggregates.spot={requested:1,covered:1,keys:[spotVenue.key],buckets:spotVenue.buckets};
  const valid=evaluateRegimeV2(p,f.history,f.flow,'5m',f.now);assert.equal(valid.aggregates.spotCovered,1);assert.equal(valid.venues[0].contradictions.length,1);
  spotVenue.buckets[0].complete=false;
  const missing=evaluateRegimeV2(p,f.history,f.flow,'5m',f.now);assert.equal(missing.aggregates.spotDelta,null);assert.equal(missing.aggregates.spotCovered,0);assert.equal(missing.venues[0].contradictions.length,0);
});
