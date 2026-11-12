import type { HistoryEvent } from '../shared/history.ts';
import type { FlowTrade, LiquidationEvent } from '../shared/orderflow.ts';
import { flowKey } from './orderflow-calculations.ts';

export function rawTradeHistoryEnabled(value = process.env.NOX_ARCHIVE_RAW_TRADES) {
  return value?.trim().toLowerCase() === 'true';
}

/** The short tape already supports CVD and replay. Long-term tick capture is optional. */
export function flowHistoryEvent(kind: 'trade' | 'liquidation', event: FlowTrade | LiquidationEvent,
  archiveTrades: boolean, ingestTime: number): HistoryEvent | undefined {
  if (kind === 'trade' && !archiveTrades) return;
  const key = 'marketType' in event ? flowKey(event) : `${event.exchange}:perpetual:${event.symbol}`;
  return { id: `${key}:${kind}:${event.id}`, kind, marketKey: key, projectId: null,
    eventTime: event.time, ingestTime, source: 'source' in event ? event.source : 'exchange-liquidation-snapshot',
    quality: kind === 'liquidation' ? 'partial' : 'verified-aggressor', payload: event };
}
