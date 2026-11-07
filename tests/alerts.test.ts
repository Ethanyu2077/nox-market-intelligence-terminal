import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateRules, type AlertReading, type RuleRuntime } from '../server/alert-engine.ts';
import { AlertService } from '../server/alert-service.ts';
import type { AlertRule } from '../shared/types.ts';

const rule = (overrides: Partial<AlertRule> = {}): AlertRule => ({
  id: 'r1', symbol: 'DOODUSDT', metric: 'price_change_24h', operator: 'gt', threshold: 5, enabled: true, createdAt: 1, ...overrides,
});

const reading = (value: number, source = 'test'): Map<string, AlertReading> => new Map([
  ['DOODUSDT', { values: { price_change_24h: value }, source, observedAt: 1_000 }],
]);

test('edge trigger fires once and re-arms only after the condition clears', () => {
  const runtime = new Map<string, RuleRuntime>();
  let state = evaluateRules([rule()], reading(6), runtime, 1_000, 0);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].value, 6);
  state = evaluateRules([rule()], reading(7), state.runtime, 2_000, 0);
  assert.equal(state.events.length, 0, 'still above threshold: no duplicate');
  state = evaluateRules([rule()], reading(4), state.runtime, 3_000, 0);
  assert.equal(state.events.length, 0);
  state = evaluateRules([rule()], reading(9), state.runtime, 4_000, 0);
  assert.equal(state.events.length, 1, 're-armed after clearing');
});

test('cooldown suppresses a re-fire after re-arming', () => {
  let state = evaluateRules([rule()], reading(6), new Map(), 1_000, 60_000);
  assert.equal(state.events.length, 1);
  state = evaluateRules([rule()], reading(0), state.runtime, 2_000, 60_000);
  state = evaluateRules([rule()], reading(8), state.runtime, 3_000, 60_000);
  assert.equal(state.events.length, 0, 'inside cooldown');
  state = evaluateRules([rule()], reading(0), state.runtime, 62_000, 60_000);
  state = evaluateRules([rule()], reading(8), state.runtime, 63_000, 60_000);
  assert.equal(state.events.length, 1, 'after cooldown');
});

test('lt operator and missing metrics behave correctly', () => {
  const lt = rule({ operator: 'lt', threshold: -2 });
  let state = evaluateRules([lt], new Map([['DOODUSDT', { values: { price_change_24h: -3 }, source: 's', observedAt: 1 }]]), new Map(), 1_000, 0);
  assert.equal(state.events.length, 1);

  const unavailable = rule({ metric: 'funding_rate' });
  state = evaluateRules([unavailable], reading(99), new Map(), 2_000, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.evaluations[0].state, 'unavailable');
  assert.match(state.evaluations[0].reason ?? '', /No funding_rate/);
});

test('disabled rules are reported but never fire', () => {
  const state = evaluateRules([rule({ enabled: false })], reading(99), new Map(), 1_000, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.evaluations[0].reason, 'Rule disabled');
});

test('service persists events, deduplicates within cooldown and can clear', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-alerts-'));
  try {
    let value = 9;
    const rules: AlertRule[] = [rule()];
    const service = new AlertService(directory, () => rules, () => [], 30_000, 60_000, async () => ({ values: { price_change_24h: value }, source: 'fixture', observedAt: 1_000 }));
    await service.init();
    let status = await service.evaluate(1_000);
    assert.equal(status.events.length, 1);
    assert.equal(status.rules.length, 1);

    value = 1;
    await service.evaluate(2_000);
    value = 12;
    status = await service.evaluate(3_000);
    assert.equal(status.events.length, 1, 'cooldown blocks the immediate refire');

    const onDisk = JSON.parse(await readFile(path.join(directory, 'alerts', 'events.json'), 'utf8')) as { events: unknown[] };
    assert.equal(onDisk.events.length, 1);

    await service.clearEvents();
    assert.equal(service.status().events.length, 0);
    service.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
