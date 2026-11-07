import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cooldownFor, evaluateRules, type AlertReading } from '../server/alert-engine.ts';
import { AlertService } from '../server/alert-service.ts';
import type { AlertRule } from '../shared/types.ts';

const rule = (overrides: Partial<AlertRule> = {}): AlertRule => ({
  id: 'r1', symbol: 'DOODUSDT', metric: 'price_change_24h', operator: 'gt', threshold: 5, enabled: true, createdAt: 1,
  projectId: null, venue: null, marketType: null, timeframe: null, ...overrides,
});

const reading = (value: number, at: number, extra: Partial<AlertReading> = {}): Map<string, AlertReading> => new Map([
  ['r1', { values: { price_change_24h: value }, source: 'test', observedAt: at, ...extra }],
]);

const evaluate = (rules: AlertRule[], readings: Map<string, AlertReading>, runtime = new Map(), now = 1_000, cooldownMs = 0) =>
  evaluateRules(rules, readings, runtime, now, { cooldownMs });

test('edge trigger fires once and re-arms only after the condition clears', () => {
  let state = evaluate([rule()], reading(6, 1_000), new Map(), 1_000);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].value, 6);
  state = evaluate([rule()], reading(7, 2_000), state.runtime, 2_000);
  assert.equal(state.events.length, 0, 'still above threshold: no duplicate');
  state = evaluate([rule()], reading(4, 3_000), state.runtime, 3_000);
  assert.equal(state.events.length, 0);
  state = evaluate([rule()], reading(9, 4_000), state.runtime, 4_000);
  assert.equal(state.events.length, 1, 're-armed after clearing');
});

test('cooldown suppresses a re-fire after re-arming', () => {
  let state = evaluate([rule()], reading(6, 1_000), new Map(), 1_000, 60_000);
  assert.equal(state.events.length, 1);
  state = evaluate([rule()], reading(0, 2_000), state.runtime, 2_000, 60_000);
  state = evaluate([rule()], reading(8, 3_000), state.runtime, 3_000, 60_000);
  assert.equal(state.events.length, 0, 'inside cooldown');
  state = evaluate([rule()], reading(0, 62_000), state.runtime, 62_000, 60_000);
  state = evaluate([rule()], reading(8, 63_000), state.runtime, 63_000, 60_000);
  assert.equal(state.events.length, 1, 'after cooldown');
});

test('a rule timeframe extends the cooldown', () => {
  assert.equal(cooldownFor(rule({ timeframe: '1h' }), 60_000), 3_600_000);
  assert.equal(cooldownFor(rule({ timeframe: '5m' }), 15 * 60_000), 15 * 60_000);
  let state = evaluate([rule({ timeframe: '1h' })], reading(6, 1_000), new Map(), 1_000, 60_000);
  state = evaluate([rule({ timeframe: '1h' })], reading(0, 120_000), state.runtime, 120_000, 60_000);
  state = evaluate([rule({ timeframe: '1h' })], reading(9, 200_000), state.runtime, 200_000, 60_000);
  assert.equal(state.events.length, 0, 'still inside the 1h timeframe cooldown');
});

test('stale and missing readings are unavailable, never a silent false', () => {
  const stale = evaluate([rule()], reading(6, 1_000, { stale: true, reason: 'stale fixture' }), new Map(), 1_000);
  assert.equal(stale.events.length, 0);
  assert.equal(stale.evaluations[0].state, 'unavailable');
  assert.match(stale.evaluations[0].reason ?? '', /stale fixture/);

  const tooOld = evaluate([rule()], reading(6, 0), new Map(), 10 * 60_000);
  assert.equal(tooOld.events.length, 0);
  assert.match(tooOld.evaluations[0].reason ?? '', /Stale reading/);

  const missing = evaluate([rule({ metric: 'funding_rate' })], reading(99, 1_000), new Map(), 1_000);
  assert.equal(missing.events.length, 0);
  assert.match(missing.evaluations[0].reason ?? '', /No funding_rate/);
});

test('disabled rules are reported but never fire', () => {
  const state = evaluate([rule({ enabled: false })], reading(99, 1_000), new Map(), 1_000);
  assert.equal(state.events.length, 0);
  assert.equal(state.evaluations[0].reason, 'Rule disabled');
});

test('events carry scope and a deterministic idempotency key', () => {
  const scoped = rule({ projectId: 'p1', venue: 'bybit', marketType: 'perpetual', timeframe: '5m' });
  const first = evaluate([scoped], reading(6, 1_000), new Map(), 1_000);
  const event = first.events[0];
  assert.deepEqual(event.scope, { projectId: 'p1', venue: 'bybit', marketType: 'perpetual', timeframe: '5m' });
  assert.equal(event.idempotencyKey, 'r1:1000:6.00000000');
  // Replaying the same observation after a lost runtime state yields the same key.
  const replay = evaluate([scoped], reading(6, 1_000), new Map(), 9_000);
  assert.equal(replay.events[0].idempotencyKey, event.idempotencyKey);
});

test('service persists runtime, deliveries and does not re-fire after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-alerts-'));
  try {
    let value = 9;
    let observedAt = 1_000;
    const rules: AlertRule[] = [rule()];
    const resolver = async () => ({ values: { price_change_24h: value }, source: 'fixture', observedAt });
    const first = new AlertService(directory, () => rules, () => [], 30_000, 60_000, resolver);
    await first.init();
    let status = await first.evaluate(1_000);
    assert.equal(status.events.length, 1);
    assert.equal(status.deliveries.length, 1);
    assert.equal(status.deliveries[0].status, 'delivered');
    assert.equal(status.stateVersion, 2);
    first.stop();

    // New process, same directory: the armed=false runtime must suppress a duplicate.
    const second = new AlertService(directory, () => rules, () => [], 30_000, 60_000, resolver);
    await second.init();
    status = await second.evaluate(2_000);
    assert.equal(status.events.length, 1, 'no duplicate after restart');

    // Clearing the condition re-arms, but the cooldown still blocks an immediate re-fire.
    value = 1; observedAt = 3_000; await second.evaluate(3_000);
    value = 9; observedAt = 4_000; status = await second.evaluate(4_000);
    assert.equal(status.events.length, 1, 'cooldown after re-arm');

    const onDisk = JSON.parse(await readFile(path.join(directory, 'alerts', 'state.json'), 'utf8')) as { runtime: Record<string, { armed: boolean }>; deliveries: Record<string, unknown> };
    assert.equal(onDisk.runtime.r1.armed, false);
    assert.equal(Object.keys(onDisk.deliveries).length, 1);

    await second.clearEvents();
    assert.equal(second.status().events.length, 0);
    second.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
