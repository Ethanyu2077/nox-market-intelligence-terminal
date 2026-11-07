import type { AlertRule, ExchangeId, ProjectMarketType } from './types.ts';

export type AlertMetric = AlertRule['metric'];
export type AlertOperator = AlertRule['operator'];
export type AlertTimeframe = NonNullable<AlertRule['timeframe']>;

/** Scope carried by an event so a reader can tell exactly what was evaluated. */
export interface AlertScope {
  projectId: string | null;
  venue: ExchangeId | null;
  marketType: ProjectMarketType | null;
  timeframe: AlertTimeframe | null;
}

export type AlertDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface AlertDelivery {
  eventId: string;
  status: AlertDeliveryStatus;
  attempts: number;
  lastAttemptAt: number;
  error: string | null;
}

export interface AlertEvent {
  id: string;
  /** Deterministic key so a restart or replay cannot append the same crossing twice. */
  idempotencyKey: string;
  ruleId: string;
  symbol: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  value: number;
  scope: AlertScope;
  observedAt: number;
  triggeredAt: number;
  source: string;
}

/** Persisted per-rule state; survives restarts so an armed edge is not re-fired. */
export interface AlertRuntime {
  armed: boolean;
  lastFiredAt: number | null;
  lastValue: number | null;
  lastEvaluatedAt: number | null;
}

export interface AlertEvaluation {
  ruleId: string;
  symbol: string;
  state: 'ok' | 'unavailable' | 'suppressed';
  value: number | null;
  reason: string | null;
  scope: AlertScope;
}

export interface AlertsStatus {
  rules: AlertRule[];
  events: AlertEvent[];
  evaluations: AlertEvaluation[];
  deliveries: AlertDelivery[];
  lastEvaluatedAt: number | null;
  nextEvaluationAt: number | null;
  intervalMs: number;
  cooldownMs: number;
  /** The persisted state file and its schema version, for operator visibility. */
  stateVersion: number;
}

export const ALERT_METRICS: Array<{ id: AlertMetric; label: string; unit: string }> = [
  { id: 'price_change_24h', label: '24h price change', unit: '%' },
  { id: 'funding_rate', label: 'Funding rate', unit: 'decimal per interval' },
  { id: 'volume_24h_usd', label: '24h volume', unit: 'USDT' },
];

export const ALERT_TIMEFRAMES: AlertTimeframe[] = ['1m', '5m', '15m', '1h', '4h'];

export function timeframeMs(timeframe: AlertTimeframe | null): number {
  if (!timeframe) return 0;
  const value = Number(timeframe.slice(0, -1));
  return value * (timeframe.endsWith('m') ? 60_000 : 3_600_000);
}
