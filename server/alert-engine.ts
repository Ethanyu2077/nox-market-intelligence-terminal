import type { AlertRule } from '../shared/types.ts';
import { timeframeMs, type AlertEvent, type AlertEvaluation, type AlertRuntime, type AlertScope } from '../shared/alerts.ts';

/**
 * Alert evaluation, kept pure so edge triggering, scoping, staleness and cooldown are
 * testable without a server or a network.
 *
 * Semantics:
 *  - edge-triggered: a rule fires on the false→true transition, not on every poll;
 *  - re-armed only when the condition becomes false again;
 *  - cooldown: at least the default window and at least the rule's own timeframe;
 *  - stale or missing readings are `unavailable`, never treated as "condition false";
 *  - the runtime map is returned so the caller can persist it across restarts.
 */

export interface AlertReading {
  values: Partial<Record<AlertRule['metric'], number | null>>;
  source: string;
  observedAt: number;
  /** Explicitly flagged by the resolver when the snapshot is older than its budget. */
  stale?: boolean;
  reason?: string;
}

export const MAX_READING_AGE_MS = 5 * 60_000;

export function scopeOf(rule: AlertRule): AlertScope {
  return {
    projectId: rule.projectId ?? null,
    venue: rule.venue ?? null,
    marketType: rule.marketType ?? null,
    timeframe: rule.timeframe ?? null,
  };
}

export function conditionMatches(rule: Pick<AlertRule, 'operator' | 'threshold'>, value: number): boolean {
  return rule.operator === 'gt' ? value > rule.threshold : value < rule.threshold;
}

/** Cooldown is never shorter than the rule's evaluation timeframe. */
export function cooldownFor(rule: AlertRule, defaultCooldownMs: number): number {
  return Math.max(defaultCooldownMs, timeframeMs(rule.timeframe ?? null));
}

export interface EvaluateOptions {
  cooldownMs: number;
  maxReadingAgeMs?: number;
}

export function evaluateRules(
  rules: AlertRule[],
  readings: Map<string, AlertReading>,
  runtime: Map<string, AlertRuntime>,
  now: number,
  options: EvaluateOptions,
): { events: AlertEvent[]; evaluations: AlertEvaluation[]; runtime: Map<string, AlertRuntime> } {
  const { cooldownMs, maxReadingAgeMs = MAX_READING_AGE_MS } = options;
  const events: AlertEvent[] = [];
  const evaluations: AlertEvaluation[] = [];
  const next = new Map(runtime);

  for (const rule of rules) {
    const scope = scopeOf(rule);
    const state: AlertRuntime = next.get(rule.id) ?? { armed: true, lastFiredAt: null, lastValue: null, lastEvaluatedAt: null };
    const base = { ruleId: rule.id, symbol: rule.symbol, scope };

    if (!rule.enabled) {
      evaluations.push({ ...base, state: 'unavailable', value: null, reason: 'Rule disabled' });
      next.set(rule.id, { ...state, lastEvaluatedAt: now });
      continue;
    }

    const reading = readings.get(rule.id);
    const value = reading?.values[rule.metric] ?? null;
    const age = reading ? now - reading.observedAt : null;
    if (!reading || value == null || !Number.isFinite(value)) {
      // A missing metric must not be treated as "condition false": keep the armed state
      // as-is and report why the rule could not be evaluated.
      evaluations.push({ ...base, state: 'unavailable', value: null, reason: reading ? `No ${rule.metric} for ${rule.symbol}` : `No covered snapshot for ${rule.symbol}` });
      next.set(rule.id, { ...state, lastEvaluatedAt: now });
      continue;
    }
    if (reading.stale || (age != null && age > maxReadingAgeMs)) {
      evaluations.push({ ...base, state: 'unavailable', value, reason: reading.reason ?? `Stale reading (${Math.round((age ?? 0) / 1000)}s old)` });
      next.set(rule.id, { ...state, lastEvaluatedAt: now, lastValue: value });
      continue;
    }

    const matches = conditionMatches(rule, value);
    if (!matches) {
      next.set(rule.id, { armed: true, lastFiredAt: state.lastFiredAt, lastValue: value, lastEvaluatedAt: now });
      evaluations.push({ ...base, state: 'ok', value, reason: null });
      continue;
    }

    const cooldown = cooldownFor(rule, cooldownMs);
    if (state.lastFiredAt != null && now - state.lastFiredAt < cooldown) {
      next.set(rule.id, { ...state, armed: false, lastValue: value, lastEvaluatedAt: now });
      evaluations.push({ ...base, state: 'suppressed', value, reason: `Cooldown active until ${new Date(state.lastFiredAt + cooldown).toISOString()}` });
      continue;
    }

    if (!state.armed) {
      // Condition is still true from the previous evaluation; already fired for this edge.
      evaluations.push({ ...base, state: 'suppressed', value, reason: 'Already fired for this crossing; waiting for the condition to clear' });
      next.set(rule.id, { ...state, lastValue: value, lastEvaluatedAt: now });
      continue;
    }

    const event: AlertEvent = {
      id: `alert_${rule.id}_${now}`,
      // Deterministic across restarts: the same rule + snapshot + value yields the same key,
      // so a lost runtime state cannot append a duplicate event.
      idempotencyKey: `${rule.id}:${reading.observedAt}:${value.toFixed(8)}`,
      ruleId: rule.id,
      symbol: rule.symbol,
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      value,
      scope,
      observedAt: reading.observedAt,
      triggeredAt: now,
      source: reading.source,
    };
    events.push(event);
    next.set(rule.id, { armed: false, lastFiredAt: now, lastValue: value, lastEvaluatedAt: now });
    evaluations.push({ ...base, state: 'ok', value, reason: null });
  }

  return { events, evaluations, runtime: next };
}
