import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aggregateCvd, backtestPositionSignals, computeOiDeltas, computeVolumeFlow, detectPositionFlowSignals, fundingCountdown, isFresh, openInterestUsd, signedTradeNotional } from '../server/calculations.ts';
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
    { time: 0, value: 9, delta: 9, buyNotional: 20, sellNotional: 11 },
    { time: 60_000, value: 39, delta: 30, buyNotional: 30, sellNotional: 0 }
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

test('OI delta keeps base and USD changes distinct and flags robust spikes', () => {
  const oiBase = [100, 101, 102, 103, 104, 140].map((value, index) => ({ time: index * 60_000, value }));
  const oiUsd = [10_000, 10_201, 10_404, 10_609, 10_816, 15_400].map((value, index) => ({ time: index * 60_000, value }));
  const result = computeOiDeltas(oiBase, oiUsd);
  assert.equal(result.at(-1)?.deltaBase, 36);
  assert.equal(result.at(-1)?.deltaUsd, 4_584);
  assert.equal(result.at(-1)?.spike, true);
  assert.equal(result[0].spike, false);
});

test('volume flow derives aggressor delta without conflating it with OI', () => {
  const flow = computeVolumeFlow([
    { time: 0, value: 60, delta: 60, buyNotional: 100, sellNotional: 40 },
    { time: 60_000, value: 40, delta: -20, buyNotional: 30, sellNotional: 50 }
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
  const flow = computeVolumeFlow(candles.map((candle, index) => ({ time: candle.time, value: (index + 1) * 50, delta: 50, buyNotional: 80, sellNotional: 30 })));
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
