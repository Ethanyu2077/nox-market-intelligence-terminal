import type { AlertRule } from '../shared/types.ts';
import type { AlertEvent, AlertEvaluation } from '../shared/alerts.ts';

/**
 * Alert evaluation, kept pure so the edge-trigger and cooldown logic is testable without
 * a server or a network.
 *
 * Semantics:
 *  - edge-triggered: a rule fires on the false→true transition, not on every poll;
 *  - re-armed only when the condition becomes false again;
 *  - cooldown: a rule that fired recently cannot fire again even if it re-arms, which
 *    stops flapping thresholds from spamming the event log.
 */

export interface AlertReading {
  values: Partial<Record<AlertRule['metric'], number | null>>;
  source: string;
  observedAt: number;
}

export interface RuleRuntime {
  armed: boolean;
  lastFiredAt: number | null;
}

export interface EvaluationResult {
  events: AlertEvent[];
  evaluations: AlertEvaluation[];
  runtime: Map<string, RuleRuntime>;
}

export function conditionMatches(rule: Pick<AlertRule, 'operator' | 'threshold'>, value: number): boolean {
  return rule.operator === 'gt' ? value > rule.threshold : value < rule.threshold;
}

export function evaluateRules(
  rules: AlertRule[],
  readings: Map<string, AlertReading>,
  runtime: Map<string, RuleRuntime>,
  now: number,
  cooldownMs: number,
): EvaluationResult {
  const events: AlertEvent[] = [];
  const evaluations: AlertEvaluation[] = [];
  const next = new Map(runtime);

  for (const rule of rules) {
    const state = next.get(rule.id) ?? { armed: true, lastFiredAt: null };
    if (!rule.enabled) {
      evaluations.push({ ruleId: rule.id, symbol: rule.symbol, state: 'unavailable', value: null, reason: 'Rule disabled' });
      next.set(rule.id, state);
      continue;
    }
    const reading = readings.get(rule.symbol);
    const value = reading?.values[rule.metric] ?? null;
    if (!reading || value == null || !Number.isFinite(value)) {
      // A missing metric must not be treated as "condition false": keep the armed state
      // as-is and report why the rule could not be evaluated.
      evaluations.push({ ruleId: rule.id, symbol: rule.symbol, state: 'unavailable', value: null, reason: reading ? `No ${rule.metric} for ${rule.symbol}` : `No covered snapshot for ${rule.symbol}` });
      next.set(rule.id, state);
      continue;
    }

    const matches = conditionMatches(rule, value);
    if (!matches) {
      next.set(rule.id, { armed: true, lastFiredAt: state.lastFiredAt });
      evaluations.push({ ruleId: rule.id, symbol: rule.symbol, state: 'ok', value, reason: null });
      continue;
    }

    if (state.lastFiredAt != null && now - state.lastFiredAt < cooldownMs) {
      next.set(rule.id, { ...state, armed: false });
      evaluations.push({ ruleId: rule.id, symbol: rule.symbol, state: 'suppressed', value, reason: `Cooldown active until ${new Date(state.lastFiredAt + cooldownMs).toISOString()}` });
      continue;
    }

    if (!state.armed) {
      // Condition is still true from the previous evaluation; already fired for this edge.
      evaluations.push({ ruleId: rule.id, symbol: rule.symbol, state: 'suppressed', value, reason: 'Already fired for this crossing; waiting for the condition to clear' });
      continue;
    }

    const event: AlertEvent = {
      id: `alert_${rule.id}_${now}`,
      ruleId: rule.id,
      symbol: rule.symbol,
      metric: rule.metric,
      operator: rule.operator,
      threshold: rule.threshold,
      value,
      observedAt: reading.observedAt,
      triggeredAt: now,
      source: reading.source,
    };
    events.push(event);
    next.set(rule.id, { armed: false, lastFiredAt: now });
    evaluations.push({ ruleId: rule.id, symbol: rule.symbol, state: 'ok', value, reason: null });
  }

  return { events, evaluations, runtime: next };
}
