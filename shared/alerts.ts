import type { AlertRule } from './types.ts';

export type AlertMetric = AlertRule['metric'];
export type AlertOperator = AlertRule['operator'];

export interface AlertEvent {
  id: string;
  ruleId: string;
  symbol: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  value: number;
  /** When the condition was observed on the snapshot. */
  observedAt: number;
  /** When the engine evaluated it. */
  triggeredAt: number;
  source: string;
}

export interface AlertEvaluation {
  ruleId: string;
  symbol: string;
  state: 'ok' | 'unavailable' | 'suppressed';
  value: number | null;
  reason: string | null;
}

export interface AlertsStatus {
  rules: AlertRule[];
  events: AlertEvent[];
  evaluations: AlertEvaluation[];
  lastEvaluatedAt: number | null;
  nextEvaluationAt: number | null;
  intervalMs: number;
  cooldownMs: number;
}

export const ALERT_METRICS: Array<{ id: AlertMetric; label: string; unit: string }> = [
  { id: 'price_change_24h', label: '24h price change', unit: '%' },
  { id: 'funding_rate', label: 'Funding rate', unit: 'decimal per interval' },
  { id: 'volume_24h_usd', label: '24h volume', unit: 'USDT' },
];
