import test from 'node:test';
import assert from 'node:assert/strict';
import { researchWindow } from '../shared/research-window.ts';
import { computeLedger, allocateByCapital, equityCurve, type LedgerInput } from '../shared/execution-ledger.ts';
import { backtestPositionSignals, computeOiDeltas, detectPositionFlowSignals } from '../server/calculations.ts';
import type { CandlePoint, PositionFlowSignal } from '../shared/types.ts';

const candles: CandlePoint[] = Array.from({ length: 100 }, (_, i) => ({ time: i * 60_000, open: 100, close: 100, high: 101, low: 99, volumeBase: 10, volumeUsd: 1000 }));

test('research outcomes purge train/test boundary crossings and unfinished candles', () => {
  assert.equal(researchWindow(candles, 18, 3, { end: 20 * 60_000 }), null);
  assert.equal(researchWindow(candles, 17, 3, { end: 20 * 60_000 })?.exitTime, 20 * 60_000);
  assert.equal(researchWindow(candles, 20, 3, { start: 20 * 60_000, end: 23 * 60_000 })?.entryTime, 20 * 60_000);
  assert.equal(researchWindow(candles, 20, 3, { end: 23 * 60_000 - 1 }), null);
  assert.equal(researchWindow(candles, 20, 3, { availableAt: 20 * 60_000 + 1 }), null);
  assert.equal(researchWindow(candles, 20, 3, { delayBars: 1, end: 23 * 60_000 }), null);
});

test('research refuses gaps and invalid horizons', () => {
  const gap = candles.map(c => ({ ...c })); gap[21].time += 1;
  assert.equal(researchWindow(gap, 20, 3), null);
  assert.throws(() => researchWindow(candles, 20, 0), /horizon/);
});

test('ledger rejects nonfinite costs, invalid side, arithmetic overflow and capital bypass', () => {
  const base: LedgerInput = { side: 'long', quantity: 1, entryPrice: 100, exitPrice: 101 };
  for (const bad of [{ feeBpsPerSide: NaN }, { feeBpsPerSide: Infinity }, { slippageBpsPerSide: 10000 }, { fundingCash: NaN }, { side: 'invalid' }, { quantity: Number.MAX_VALUE }]) {
    assert.throws(() => computeLedger({ ...base, ...bad } as LedgerInput));
  }
  assert.throws(() => allocateByCapital([], 100, NaN), /maxLeverage/);
  assert.throws(() => allocateByCapital([{ entryNotional: 100, entryTime: 2, exitTime: 1 }], 100), /trade times/);
  assert.equal(equityCurve([{ netPnlQuote: 10 }, { netPnlQuote: 0 }], 100).winRatePct, 50);
});

test('constant flow cannot create absorption by increasing window length', () => {
  const oi = candles.map((c, i) => ({ time: c.time, value: 1000 + i }));
  const deltas = computeOiDeltas(oi, oi);
  const flow = candles.map(c => ({ time: c.time, value: 10, buyNotional: 60, sellNotional: 50, deltaNotional: 10, imbalancePct: 100 / 11, deltaChangePct: null, complete: true }));
  const signals = detectPositionFlowSignals(candles, deltas, flow, 100 * 60_000, { windowSteps: 12, limit: Infinity });
  assert.equal(signals.filter(s => s.type === 'market_absorption').length, 0);
  // Genuine same-duration flow expansion remains a candidate, always withheld without L2.
  const surge = flow.map((p, i) => i >= 80 && i < 92 ? { ...p, deltaNotional: 100, buyNotional: 150 } : p);
  const absorption = detectPositionFlowSignals(candles, deltas, surge, 100 * 60_000, { windowSteps: 12, limit: Infinity }).find(s => s.type === 'market_absorption');
  assert.ok(absorption);
  assert.equal(absorption.status, 'withheld');
  assert.ok(absorption.evidence.some(e => e.includes('SAME duration')));
});

test('production research path uses ledger costs, excludes withheld and censors asOf', () => {
  const signal = { type: 'potential_long_buildup', status: 'hypothesis', time: 20 * 60_000 } as PositionFlowSignal;
  const result = backtestPositionSignals([signal, { ...signal, status: 'withheld' }], candles, 3, 23 * 60_000)[0];
  assert.equal(result.resolvedSamples, 1);
  assert.equal(result.withheldSamples, 1);
  const expected = computeLedger({ side: 'long', quantity: 1, entryPrice: 100, exitPrice: 100, feeBpsPerSide: 5, slippageBpsPerSide: 1 });
  assert.equal(result.execution?.averageNetBeforeFundingPct, expected.notionalReturnPct);
  assert.equal(result.execution?.funding, 'unavailable');
  assert.equal(result.execution?.positiveAfterCostsPct, 0);
  assert.equal(backtestPositionSignals([signal], candles, 3, 23 * 60_000 - 1)[0].resolvedSamples, 0);
});

test('adaptive absorption evidence does not claim price and OI exceeded thresholds', () => {
  const price = candles.map((c, i) => ({ ...c, close: i < 80 && i % 2 ? 101 : 100 }));
  const oi = candles.map((c, i) => ({ time: c.time, value: 1000 + i }));
  const flow = candles.map((c, i) => ({ time: c.time, value: 10, buyNotional: i >= 80 ? 150 : 60, sellNotional: 50, deltaNotional: i >= 80 ? 100 : 10, imbalancePct: 10, deltaChangePct: null, complete: true }));
  const signal = detectPositionFlowSignals(price, computeOiDeltas(oi, oi), flow, 100 * 60_000, { windowSteps: 3, adaptive: { quantile: 0.9, lookbackWindows: 50, minHistory: 20 }, limit: Infinity }).find(s => s.type === 'market_absorption');
  assert.ok(signal);
  assert.ok(signal.evidence.some(e => e.includes('price passed=false')));
  assert.ok(!signal.evidence.some(e => e.includes('Price and OI moves exceed')));
});
