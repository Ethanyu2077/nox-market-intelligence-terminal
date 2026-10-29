import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aggregateCvd, backtestPositionSignals, computeOiDeltas, computeVolumeFlow, DEFAULT_SIGNAL_RULES, detectPositionFlowSignals, fundingCountdown, isFresh, openInterestUsd, signedTradeNotional } from '../server/calculations.ts';
import { FileStore } from '../server/store.ts';
import type { CandlePoint } from '../shared/types.ts';

test('buyer-maker trades are signed as aggressor sells', () => {
  assert.equal(signedTradeNotional({ a: 1, p: '100', q: '2', T: 1, m: true }), -200);
  assert.equal(signedTradeNotional({ a: 2, p: '100', q: '2', T: 2, m: false }), 200);
});

test('CVD groups by event-time bucket and resets baseline at window start', () => {
  const series = aggregateCvd([
    { a: 3, p: '10', q: '3', T: 65_000, m: false },
    { a: 1, p: '10', q: '2', T: 5_000, m: false },
    { a: 2, p: '11', q: '1', T: 25_000, m: true }
  ], 60_000);
  assert.deepEqual(series, [
    { time: 0, value: 9, delta: 9, buyNotional: 20, sellNotional: 11, complete: false },
    { time: 60_000, value: 39, delta: 30, buyNotional: 30, sellNotional: 0, complete: false }
  ]);
});

test('OI USD is mark-price notional and does not alter base quantity', () => {
  const base = 125.5;
  assert.equal(openInterestUsd(base, 100), 12_550);
  assert.equal(openInterestUsd(base, 80), 10_040);
  assert.equal(base, 125.5);
});

test('freshness and funding countdown clamp correctly', () => {
  assert.equal(isFresh(9_000, 2_000, 10_000), true);
  assert.equal(isFresh(7_000, 2_000, 10_000), false);
  assert.equal(fundingCountdown(8_000, 10_000), 0);
  assert.equal(fundingCountdown(12_500, 10_000), 2_500);
});

test('OI delta keeps base and USD changes distinct and flags robust spikes point-in-time', () => {
  const oiBase = [100, 102, 103, 102, 105, 140].map((value, index) => ({ time: index * 60_000, value }));
  const oiUsd = [10_000, 10_201, 10_404, 10_609, 10_816, 15_400].map((value, index) => ({ time: index * 60_000, value }));
  const result = computeOiDeltas(oiBase, oiUsd);
  assert.equal(result.at(-1)?.deltaBase, 35);
  assert.equal(result.at(-1)?.deltaUsd, 4_584);
  assert.equal(result.at(-1)?.spike, true);
  assert.equal(result[0].spike, false);
  // Prefix invariance: appending future OI must not rewrite an earlier spike score.
  const extendedBase = [...oiBase, ...Array.from({ length: 20 }, (_, index) => ({ time: (6 + index) * 60_000, value: 140 + index * 17 }))];
  const extendedUsd = [...oiUsd, ...Array.from({ length: 20 }, (_, index) => ({ time: (6 + index) * 60_000, value: 15_400 + index * 1_700 }))];
  const extended = computeOiDeltas(extendedBase, extendedUsd);
  assert.equal(extended.at(-21)?.robustScore, result.at(-1)?.robustScore);
  assert.equal(extended.at(-21)?.spike, result.at(-1)?.spike);
});

test('missing USD OI stays null and never fabricates a zero-based delta', () => {
  const oiBase = [{ time: 0, value: 100 }, { time: 60_000, value: 110 }, { time: 120_000, value: 120 }];
  const oiUsd = [{ time: 0, value: 10_000 }];
  const result = computeOiDeltas(oiBase, oiUsd);
  assert.equal(result[0].deltaBase, 10);
  assert.equal(result[0].usdValue, null);
  assert.equal(result[0].deltaUsd, null);
  assert.equal(result[0].pctUsd, null);
  // The base-unit delta is still authoritative; only the unavailable USD pair is null.
  assert.equal(result[0].pctBase, 10);
});

test('volume flow derives aggressor delta without conflating it with OI', () => {
  const flow = computeVolumeFlow([
    { time: 0, value: 60, delta: 60, buyNotional: 100, sellNotional: 40, complete: true },
    { time: 60_000, value: 40, delta: -20, buyNotional: 30, sellNotional: 50, complete: true }
  ]);
  assert.equal(flow[0].deltaNotional, 60);
  assert.equal(flow[0].imbalancePct, 60 / 140 * 100);
  assert.equal(flow[1].deltaNotional, -20);
  assert.equal(flow[1].deltaChangePct, null);
});

test('position classification remains probabilistic and backtest resolves forward bars', () => {
  const candles: CandlePoint[] = Array.from({ length: 8 }, (_, index) => ({
    time: index * 60_000, open: 100 + index, high: 101.5 + index, low: 99.5 + index,
    close: 101 + index, volumeBase: 10, volumeUsd: 1_000
  }));
  const oiBase = [100, 101, 102, 103, 104, 110, 111, 112].map((value, index) => ({ time: index * 60_000, value }));
  const oiUsd = oiBase.map((point, index) => ({ time: point.time, value: point.value * (101 + index) }));
  const deltas = computeOiDeltas(oiBase, oiUsd);
  const flow = computeVolumeFlow(candles.map((candle, index) => ({ time: candle.time, value: (index + 1) * 50, delta: 50, buyNotional: 80, sellNotional: 30, complete: true })));
  const signals = detectPositionFlowSignals(candles, deltas, flow, candles.at(-1)!.time);
  const buildup = signals.find((signal) => signal.type === 'potential_long_buildup');
  assert.ok(buildup);
  assert.match(buildup.inferenceNotice, /not directly observed/i);
  const backtest = backtestPositionSignals(signals, candles, 1);
  const result = backtest.find((item) => item.type === 'potential_long_buildup');
  assert.ok(result);
  assert.ok(result.resolvedSamples > 0);
  assert.equal(result.hitRate, 100);
});

test('project database starts empty and persists create, select, reorder and archive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nox-project-store-'));
  try {
    const store = new FileStore(directory); await store.init();
    assert.deepEqual(store.getProjects(true), []);
    const market = { id: 'binance:perpetual:ARBUSDT', exchange: 'binance' as const, marketType: 'perpetual' as const, symbol: 'ARBUSDT', base: 'ARB', quote: 'USDT', status: 'TRADING' };
    const first = await store.addProject({ name: 'Arbitrum', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null, markets: [market], primaryMarketId: market.id });
    const secondMarket = { ...market, id: 'binance:perpetual:OPUSDT', symbol: 'OPUSDT', base: 'OP' };
    const second = await store.addProject({ name: 'Optimism', tokenSymbol: 'OP', contractAddress: null, identitySource: 'symbol', identityNetwork: null, markets: [secondMarket], primaryMarketId: secondMarket.id });
    await store.setSelectedProject(second.id);
    await store.reorderProjects([second.id, first.id]);
    await store.updateProject(second.id, { archived: true });
    const reopened = new FileStore(directory); await reopened.init();
    assert.equal(reopened.getProjects(true)[0].id, second.id);
    assert.equal(reopened.getProjects().length, 1);
    assert.equal(reopened.getSelectedProjectId(), first.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('1m price/flow bars are never mixed with a 5m OI window and never use a future bar', () => {
  // 1m candles for minutes 0..11. The 10m->11m close jumps +0.50%, but the true window that the
  // OI snapshot at 12:00? covers (close at 5m -> close at 10m) is flat. The previous implementation
  // paired the OI delta with the bar STARTING at the snapshot time (i.e. future data) and produced
  // a false "Potential Long Build-up".
  const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100.5, 100.6];
  const candles: CandlePoint[] = closes.map((close, index) => ({
    time: index * 60_000, open: close, high: close + 0.05, low: close - 0.05, close, volumeBase: 10, volumeUsd: 1_000
  }));
  const oiBase = [100, 110, 121].map((value, index) => ({ time: index * 300_000, value }));
  const oiUsd = oiBase.map((point) => ({ time: point.time, value: point.value * 100 }));
  const deltas = computeOiDeltas(oiBase, oiUsd);
  const volumeFlow = candles.map((candle, index) => {
    // Minutes 5..9 are exactly the 5m flow window of the second OI delta: a balanced tape.
    const delta = index >= 5 && index <= 9 ? 0 : index % 2 === 0 ? 10 : -10;
    return { time: candle.time, value: delta, buyNotional: delta > 0 ? delta : 0, sellNotional: delta < 0 ? -delta : 0, deltaNotional: delta, imbalancePct: delta > 0 ? 100 : delta < 0 ? -100 : 0, deltaChangePct: null, complete: true };
  });
  const signals = detectPositionFlowSignals(candles, deltas, volumeFlow, candles.at(-1)!.time);
  assert.deepEqual(signals, []);
});

function signalFixture(closes: number[], flowForIndex: (index: number) => number | null, oiValues = [100, 110, 121]) {
  const candles: CandlePoint[] = closes.map((close, index) => ({
    time: index * 60_000, open: close, high: close + 0.01, low: close - 0.01, close, volumeBase: 10, volumeUsd: 1_000
  }));
  const oiBase = oiValues.map((value, index) => ({ time: index * 300_000, value }));
  const oiUsd = oiBase.map((point) => ({ time: point.time, value: point.value * 100 }));
  const deltas = computeOiDeltas(oiBase, oiUsd);
  const volumeFlow = candles.flatMap((candle, index) => {
    const delta = flowForIndex(index);
    if (delta == null) return [];
    return [{ time: candle.time, value: delta, buyNotional: delta > 0 ? delta : 0, sellNotional: delta < 0 ? -delta : 0, deltaNotional: delta, imbalancePct: delta > 0 ? 100 : delta < 0 ? -100 : 0, deltaChangePct: null, complete: true }];
  });
  return { candles, deltas, volumeFlow, now: candles.at(-1)!.time };
}

test('labels are withheld when aggressor-flow coverage is below the gate', () => {
  // Rising 0.1%/minute; only one of the five 1m buckets inside the 5m OI window has flow.
  const fixture = signalFixture(Array.from({ length: 12 }, (_, index) => 100 + index * 0.1), (index) => (index === 5 ? 10 : null));
  const signals = detectPositionFlowSignals(fixture.candles, fixture.deltas, fixture.volumeFlow, fixture.now);
  const signal = signals[0];
  assert.ok(signal);
  assert.equal(signal.status, 'withheld');
  assert.ok(signal.missing.some((item) => item.includes('complete aggressor-flow buckets 1/5')));
  assert.equal(signal.coverage.expectedWindowBars, 5);
  assert.equal(signal.coverage.flowBars, 1);
  assert.equal(signal.confidenceBasis, 'heuristic-rule-uncalibrated');
  assert.ok(signal.alternatives.length >= 2 && signal.invalidation.length >= 2);
  const results = backtestPositionSignals(signals, fixture.candles, 1);
  assert.equal(results[0].samples, 0);
  assert.equal(results[0].resolvedSamples, 0);
  assert.equal(results[0].withheldSamples, 1);
  assert.equal(results[0].hitRate, null);
});

test('liquidation labels are withheld without per-event liquidation data even when flow is complete', () => {
  const fixture = signalFixture(Array.from({ length: 12 }, (_, index) => 100 - index * 0.1), () => -10, [121, 110, 100]);
  const signals = detectPositionFlowSignals(fixture.candles, fixture.deltas, fixture.volumeFlow, fixture.now);
  const liquidation = signals.find((signal) => signal.type === 'potential_long_liquidation');
  assert.ok(liquidation);
  assert.equal(liquidation.status, 'withheld');
  assert.ok(liquidation.missing.some((item) => item.includes('liquidation')));
  assert.equal(liquidation.coverage.flowCoveragePct, 100);
  assert.equal(liquidation.coverage.liquidationEvents, 'unavailable');
});

test('liquidation-like price declines are never presented as observed liquidations', () => {
  const fixture = signalFixture(Array.from({ length: 12 }, (_, index) => 100 - index * 0.1), () => -10, [121, 110, 100]);
  const signals = detectPositionFlowSignals(fixture.candles, fixture.deltas, fixture.volumeFlow, fixture.now);
  for (const signal of signals) {
    if (signal.type === 'potential_long_liquidation') assert.notEqual(signal.status, 'hypothesis');
    assert.ok(!/observed liquidation/i.test(signal.inferenceNotice));
  }
});

test('absorption labels are withheld without sequence-correct L2 depth', () => {
  // 60 one-minute candles and 7 five-minute OI points: the last window has 25 prior flow buckets,
  // enough for a point-in-time flow baseline (>=20), while the window flow spikes.
  const fixture = signalFixture(Array.from({ length: 60 }, () => 100), (index) => (index >= 25 && index <= 29 ? 100 : 10), [100, 110, 121, 133, 146, 161, 177]);
  const signals = detectPositionFlowSignals(fixture.candles, fixture.deltas, fixture.volumeFlow, fixture.now);
  const absorption = signals.find((signal) => signal.type === 'market_absorption');
  assert.ok(absorption);
  assert.equal(absorption.status, 'withheld');
  assert.ok(absorption.missing.some((item) => item.includes('depth')));
});

test('reliability table reports an unconditional baseline and a chronological holdout, never a win rate', () => {
  const candles: CandlePoint[] = Array.from({ length: 40 }, (_, index) => ({ time: index * 60_000, open: 100 + index * 0.1, high: 100.2 + index * 0.1, low: 99.9 + index * 0.1, close: 100.1 + index * 0.1, volumeBase: 10, volumeUsd: 1_000 }));
  const oiBase = Array.from({ length: 40 }, (_, index) => ({ time: index * 60_000, value: 100 + index }));
  const oiUsd = oiBase.map((point) => ({ time: point.time, value: point.value * 100 }));
  const deltas = computeOiDeltas(oiBase, oiUsd);
  const volumeFlow = candles.map((candle) => ({ time: candle.time, value: 10, buyNotional: 10, sellNotional: 0, deltaNotional: 10, imbalancePct: 100, deltaChangePct: null, complete: true }));
  const signals = detectPositionFlowSignals(candles, deltas, volumeFlow, candles.at(-1)!.time);
  const results = backtestPositionSignals(signals, candles, 3);
  const directional = results.find((result) => result.baselineHitRate != null);
  assert.ok(directional, 'a directional label type must expose a baseline');
  assert.ok(directional.baselineHitRate != null);
  assert.ok(directional.liftPct != null);
  assert.ok(directional.holdout != null);
  assert.match(directional.edgeStatement, /baseline|descriptive|validated/i);
  assert.equal(directional.hitRate! <= 100, true);
});

test('aggregate trades are deduplicated by venue id before CVD bucketing', () => {
  const trades = [
    { a: 1, p: '10', q: '2', T: 5_000, m: false },
    { a: 1, p: '10', q: '2', T: 5_000, m: false },
    { a: 2, p: '10', q: '3', T: 6_000, m: false },
  ];
  const series = aggregateCvd(trades, 60_000);
  assert.equal(series.length, 1);
  assert.equal(series[0].buyNotional, 50);
  assert.equal(series[0].delta, 50);
});

test('future event timestamps are never treated as fresh', () => {
  assert.equal(isFresh(9_000, 2_000, 10_000), true);
  assert.equal(isFresh(12_000, 2_000, 10_000), false);
});

// 5m candles and 5m OI: move k sets candle k's close, OI point k+1 and flow bucket k, so the OI
// window ending at point k+1 covers exactly move k.
function stepSeries(moves: Array<{ pricePct: number; oiPct: number; buy: number; sell: number }>) {
  const step = 300_000;
  let price = 100, oi = 1_000;
  const candles: CandlePoint[] = [], oiBase = [{ time: 0, value: oi }], flow = [];
  for (const [k, move] of moves.entries()) {
    const open = price; price *= 1 + move.pricePct / 100; oi *= 1 + move.oiPct / 100;
    candles.push({ time: k * step, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volumeBase: 10, volumeUsd: move.buy + move.sell });
    oiBase.push({ time: (k + 1) * step, value: oi });
    const delta = move.buy - move.sell;
    flow.push({ time: k * step, value: delta, buyNotional: move.buy, sellNotional: move.sell, deltaNotional: delta, imbalancePct: delta / (move.buy + move.sell) * 100, deltaChangePct: null, complete: true });
  }
  const deltas = computeOiDeltas(oiBase, oiBase.map((point) => ({ time: point.time, value: point.value * 100 })));
  return { candles, deltas, flow, now: oiBase.at(-1)!.time };
}
// Ordinary windows: varied 0.1–0.5% price and OI moves with mildly one-sided flow.
const quiet = (k: number) => ({ pricePct: (k % 2 ? 1 : -1) * (0.1 + (k % 5) * 0.1), oiPct: (k % 3 ? 1 : -1) * (0.1 + (k % 4) * 0.1), buy: 100 + (k % 4) * 10, sell: 100 + (k % 3) * 10 });

test('default options retain fixed-threshold single-step settings', () => {
  const s = stepSeries([...Array.from({ length: 40 }, (_, k) => quiet(k)), { pricePct: 0.5, oiPct: 1, buy: 150, sell: 50 }]);
  const implicit = detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now);
  assert.deepEqual(detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now, DEFAULT_SIGNAL_RULES), implicit);
  // Fixed 0.08% / 0.05% thresholds label most quiet 0.3% / 0.2% windows.
  assert.ok(implicit.length > 20);
});

test('adaptive thresholds label only moves beyond the market\'s own prior range', () => {
  const s = stepSeries([...Array.from({ length: 40 }, (_, k) => quiet(k)), { pricePct: 1, oiPct: 1, buy: 150, sell: 50 }]);
  const adaptive = { quantile: 0.9, lookbackWindows: 288, minHistory: 30 };
  const signals = detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now, { adaptive, limit: Infinity });
  assert.deepEqual(signals.map((signal) => signal.type), ['potential_long_buildup']);
  assert.equal(signals[0].time, s.now);
  assert.ok(signals[0].evidence.some((line) => /Prior 39 windows: 90th percentile/.test(line)));
  // Too little history is a refusal, not a fallback to fixed thresholds.
  assert.deepEqual(detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now, { adaptive: { ...adaptive, minHistory: 50, lookbackWindows: 50 } }), []);
});

test('adaptive labels are point-in-time: later data never rewrites earlier labels', () => {
  const moves = Array.from({ length: 120 }, (_, k) => ({ pricePct: Math.sin(k * 1.7) * (k % 9 ? 0.3 : 1.4), oiPct: Math.cos(k * 1.3) * (k % 7 ? 0.2 : 1.1), buy: 100 + (k % 5) * 20, sell: 100 + (k % 3) * 25 }));
  const rules = { adaptive: { quantile: 0.8, lookbackWindows: 50, minHistory: 20 }, windowSteps: 2, limit: Infinity };
  const full = stepSeries(moves), prefix = stepSeries(moves.slice(0, 80));
  const fullSignals = detectPositionFlowSignals(full.candles, full.deltas, full.flow, full.now, rules);
  const prefixSignals = detectPositionFlowSignals(prefix.candles, prefix.deltas, prefix.flow, prefix.now, rules);
  assert.ok(prefixSignals.length > 0);
  assert.deepEqual(fullSignals.filter((signal) => signal.time <= prefix.now).map((signal) => signal.id), prefixSignals.map((signal) => signal.id));
});

test('a minimum flow imbalance rejects barely one-sided flow', () => {
  const s = stepSeries([quiet(0), { pricePct: 0.5, oiPct: 1, buy: 51, sell: 49 }]);
  assert.equal(detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now)[0]?.type, 'potential_long_buildup');
  assert.deepEqual(detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now, { minFlowImbalancePct: 15 }).filter((signal) => signal.type === 'potential_long_buildup'), []);
  const strong = stepSeries([quiet(0), { pricePct: 0.5, oiPct: 1, buy: 70, sell: 30 }]);
  assert.equal(detectPositionFlowSignals(strong.candles, strong.deltas, strong.flow, strong.now, { minFlowImbalancePct: 15 })[0]?.type, 'potential_long_buildup');
});

test('multi-step windows measure price, OI and flow over the whole window', () => {
  // Each 5m step is below the fixed thresholds; three steps together exceed them.
  const s = stepSeries([quiet(0), ...Array.from({ length: 3 }, () => ({ pricePct: 0.05, oiPct: 0.03, buy: 60, sell: 40 }))]);
  assert.deepEqual(detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now), []);
  const [signal] = detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now, { windowSteps: 3 });
  assert.equal(signal?.type, 'potential_long_buildup');
  assert.equal(signal.coverage.expectedWindowBars, 3);
  assert.equal(signal.volumeDeltaUsd, 60);
  assert.ok(Math.abs(signal.oiDeltaPct - (1.0003 ** 3 - 1) * 100) < 1e-9);
});

test('invalid signal rule options are rejected', () => {
  const s = stepSeries([quiet(0), quiet(1)]);
  for (const options of [{ windowSteps: 0 }, { windowSteps: 1.5 }, { minFlowImbalancePct: Number.NaN }, { minFlowImbalancePct: 101 }, { limit: 0 }, { adaptive: { quantile: 1, lookbackWindows: 10, minHistory: 5 } }, { adaptive: { quantile: 0.8, lookbackWindows: 10, minHistory: 20 } }]) {
    assert.throws(() => detectPositionFlowSignals(s.candles, s.deltas, s.flow, s.now, options), /must|needs/);
  }
});
