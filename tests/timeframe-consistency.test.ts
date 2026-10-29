import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeframeAlignmentResponse, evaluateTimeframeAlignment, observeTimeframe } from '../server/timeframe-consistency.ts';
import type { MarketSeries } from '../shared/types.ts';
import type { TimeframeInterval, TimeframeObservation, TimeframeState } from '../shared/timeframe.ts';

const STEP: Record<TimeframeInterval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };

function seriesFor(interval: TimeframeInterval, closes: number[], options: { oiDelta: number; flowDelta: number; flowComplete?: boolean }): MarketSeries {
  const step = STEP[interval];
  const candles = closes.map((close, index) => ({ time: index * step, open: close - 0.01, high: close + 0.02, low: close - 0.02, close, volumeBase: 10, volumeUsd: 1_000 }));
  const oiDelta = [2, 3].map((multiplier, index) => ({
    time: (index + 2) * step, value: options.oiDelta, baseValue: 100, usdValue: 1_000, deltaBase: options.oiDelta, deltaUsd: null,
    pctBase: 1, pctUsd: null, robustScore: 0, spike: false, multiplier,
  }));
  const volumeFlow = [{ time: 2 * step, value: options.flowDelta, buyNotional: options.flowDelta > 0 ? options.flowDelta : 0, sellNotional: options.flowDelta < 0 ? -options.flowDelta : 0, deltaNotional: options.flowDelta, imbalancePct: options.flowDelta > 0 ? 100 : -100, deltaChangePct: null, complete: options.flowComplete ?? true }];
  return {
    symbol: 'ARBUSDT', interval, candles, oiBase: [], oiUsd: [], cvd: [],
    positionFlow: {
      oiInterval: interval, requestedInterval: interval, oiDelta: oiDelta as MarketSeries['positionFlow']['oiDelta'], volumeFlow,
      signals: [], backtest: [],
      methodology: { oiSpikeRule: '', volumeDeltaRule: '', classificationRule: '', evidenceGateRule: '', reliabilityRule: '', oneMinuteOiNotice: null, forwardHorizonBars: 3 },
    },
    coverage: { candlesFrom: 0, cvdFrom: 0, tradeCount: 1, cvdMethod: '', oiSource: '' },
    eventTime: 3 * step, source: 'fixture',
  };
}

const obs = (interval: TimeframeInterval, state: TimeframeState): TimeframeObservation => ({
  interval, state, priceChangePct: null, oiDeltaBase: null, oiDeltaPctBase: null, flowDeltaUsd: null, flowCoveragePct: null,
  windowFrom: null, windowTo: null, freshness: 'live', reasons: [],
});

test('timeframe observation requires price, OI and complete flow to agree', () => {
  const bullish = observeTimeframe('5m', seriesFor('5m', [100, 101, 103], { oiDelta: 5, flowDelta: 100 }), 3 * STEP['5m']);
  assert.equal(bullish.state, 'bullish');
  assert.equal(bullish.priceChangePct!.toFixed(2), '1.98');
  const bearish = observeTimeframe('5m', seriesFor('5m', [100, 99, 97], { oiDelta: -5, flowDelta: -100 }), 3 * STEP['5m']);
  assert.equal(bearish.state, 'bearish');
  const conflicted = observeTimeframe('5m', seriesFor('5m', [100, 101, 103], { oiDelta: -5, flowDelta: -100 }), 3 * STEP['5m']);
  assert.equal(conflicted.state, 'mixed');
  assert.ok(conflicted.reasons.some((reason) => reason.includes('OI')));
  const insufficient = observeTimeframe('5m', seriesFor('5m', [100, 101, 103], { oiDelta: 5, flowDelta: 100, flowComplete: false }), 3 * STEP['5m']);
  assert.equal(insufficient.state, 'insufficient');
  assert.ok(insufficient.reasons.some((reason) => reason.includes('flow')));
});

test('sub-threshold price moves are mixed, not directional', () => {
  const mixed = observeTimeframe('1m', seriesFor('1m', [100, 100.01, 100.02], { oiDelta: 5, flowDelta: 100 }), 3 * STEP['1m']);
  assert.equal(mixed.state, 'mixed');
  assert.ok(mixed.reasons.some((reason) => reason.includes('threshold')));
});

test('alignment requires at least three agreeing timeframes and refuses conflicts', () => {
  const aligned = evaluateTimeframeAlignment(['1m', '5m', '15m', '1h', '4h'].map((interval) => obs(interval as TimeframeInterval, 'bullish')));
  assert.equal(aligned.state, 'aligned-bullish');
  assert.equal(aligned.directionalClaimAllowed, true);
  assert.equal(aligned.alignedTimeframes, 5);

  const threeBullishTwoInsufficient = evaluateTimeframeAlignment([obs('1m', 'bullish'), obs('5m', 'bullish'), obs('15m', 'bullish'), obs('1h', 'insufficient'), obs('4h', 'insufficient')]);
  assert.equal(threeBullishTwoInsufficient.state, 'aligned-bullish');
  assert.equal(threeBullishTwoInsufficient.directionalClaimAllowed, true);

  const conflict = evaluateTimeframeAlignment([obs('1m', 'bullish'), obs('5m', 'bearish'), obs('15m', 'bullish'), obs('1h', 'bullish'), obs('4h', 'bullish')]);
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.directionalClaimAllowed, false);

  const mixed = evaluateTimeframeAlignment([obs('1m', 'bullish'), obs('5m', 'bullish'), obs('15m', 'bullish'), obs('1h', 'mixed'), obs('4h', 'bullish')]);
  assert.equal(mixed.state, 'mixed');
  assert.equal(mixed.directionalClaimAllowed, false);

  const insufficient = evaluateTimeframeAlignment([obs('1m', 'bullish'), obs('5m', 'insufficient'), obs('15m', 'insufficient'), obs('1h', 'insufficient'), obs('4h', 'insufficient')]);
  assert.equal(insufficient.state, 'insufficient');
  assert.equal(insufficient.directionalClaimAllowed, false);
  assert.ok(evaluateTimeframeAlignment([]).reasons.length > 0);
});

test('alignment response documents refusal and no-vote semantics', () => {
  const response = buildTimeframeAlignmentResponse('p', 'ARBUSDT', [obs('1m', 'bullish'), obs('5m', 'bearish')], 1);
  assert.equal(response.alignment.directionalClaimAllowed, false);
  assert.ok(response.methodology.some((item) => item.includes('no vote')));
  assert.ok(response.methodology.some((item) => item.includes('calibrated')));
});

test('freshness allows one closing period plus collection lag instead of a fixed 15 minutes', () => {
  const hour = STEP['1h'];
  const liveHour = observeTimeframe('1h', seriesFor('1h', [100, 101, 103], { oiDelta: 5, flowDelta: 100 }), 3 * hour + 30 * 60_000);
  assert.equal(liveHour.freshness, 'live', 'a 1h window 30m old is normal');
  const staleHour = observeTimeframe('1h', seriesFor('1h', [100, 101, 103], { oiDelta: 5, flowDelta: 100 }), 3 * hour + 70 * 60_000);
  assert.equal(staleHour.freshness, 'stale');
  assert.ok(staleHour.reasons.some((reason) => reason.includes('1h close')));
  const liveFourHour = observeTimeframe('4h', seriesFor('4h', [100, 101, 103], { oiDelta: 5, flowDelta: 100 }), 3 * STEP['4h'] + 2 * 3_600_000);
  assert.equal(liveFourHour.freshness, 'live', 'a 4h window 2h old is normal');
  const staleMinute = observeTimeframe('1m', seriesFor('1m', [100, 101, 103], { oiDelta: 5, flowDelta: 100 }), 3 * STEP['1m'] + 20 * 60_000);
  assert.equal(staleMinute.freshness, 'stale');
  const future = observeTimeframe('5m', seriesFor('5m', [100, 101, 103], { oiDelta: 5, flowDelta: 100 }), 3 * STEP['5m'] - 10 * 60_000);
  assert.equal(future.freshness, 'stale');
  assert.ok(future.reasons.some((reason) => reason.includes('future') || reason.includes('clock skew')));
});
