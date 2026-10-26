import type { MarketProject, ProjectVenueResponse } from '../shared/types.ts';
import type { ResearchReport, SignalEvent } from '../shared/research.ts';
import { createHash } from 'node:crypto';

export const READ_ONLY_TOOLS = ['market_snapshot', 'cross_exchange_evidence', 'data_freshness'] as const;

// Only normalized public market data crosses this boundary. No store, wallet, or execution tool is exposed.
export function analyzeResearch(project: MarketProject, data: ProjectVenueResponse, now = Date.now()): ResearchReport {
  const sources = data.snapshots.map((s, i) => ({ id: `S${i + 1}`, venue: s.exchange, symbol: s.symbol, source: s.source, eventTime: s.eventTime, quality: s.quality }));
  const report: ResearchReport = { projectId: project.id, generatedAt: now, mode: 'evidence-only', sources, tools: [...READ_ONLY_TOOLS], observed: [], inferences: [], hypotheses: [], limitations: [] };
  data.snapshots.forEach((s, i) => {
    const refs = [`S${i + 1}`];
    for (const [key, unit] of [['price', 'quote/base'], ['volume24hUsd', 'USD/24h'], ['oiBase', 'base'], ['oiUsd', 'USD'], ['fundingRate', 'decimal/settlement'], ['cvd', 'USD']] as const) {
      const value = s[key];
      if (value != null && Number.isFinite(value)) report.observed.push({ text: `${s.exchange} ${s.symbol} · ${key} = ${value} ${unit}`, sources: refs });
      else report.limitations.push({ text: `${s.exchange} ${s.symbol} · ${key}: unavailable; not replaced with zero.`, sources: refs });
    }
    if (s.quality !== 'live' || now - s.eventTime > 60_000 || s.eventTime > now + 5_000) report.limitations.push({ text: `${s.exchange} ${s.symbol}: ${s.quality}; source timestamp ${new Date(s.eventTime).toISOString()}. Do not assume current.`, sources: refs });
  });
  for (const insight of data.insights) report.inferences.push({ text: `${insight.label} · heuristic confidence ${insight.confidence}% (uncalibrated). ${insight.inferenceNotice} ${insight.evidence.join(' ')}`, sources: sources.filter(s => !insight.exchange || s.venue === insight.exchange).map(s => s.id) });
  for (const failure of data.failures) report.limitations.push({ text: `${failure.exchange} ${failure.symbol}: ${failure.message}`, sources: [] });
  report.limitations.push({ text: 'CVD is the returned venue-specific trade window, not lifetime CVD. Snapshot windows are not guaranteed aligned across venues; these values must not be summed.', sources: sources.map(s => s.id) });
  report.hypotheses.push({ text: 'A positioning imbalance may explain venue differences, but OI and aggressive flow alone cannot identify ownership, position opening/closing, or liquidation causality.', sources: sources.map(s => s.id) });
  report.limitations.push({ text: 'No LLM provider is configured: this is a deterministic, read-only evidence report, not an AI-generated answer. Confidence is heuristic, not a calibrated probability. Historical replay is not an out-of-sample backtest.', sources: [] });
  return report;
}

export function signalsFromSnapshots(project: MarketProject, data: ProjectVenueResponse): SignalEvent[] {
  return data.insights.flatMap(insight => {
    const snapshot = data.snapshots.find(s => s.exchange === insight.exchange && s.marketType === 'perpetual');
    if (!snapshot || snapshot.quality !== 'live' || Math.abs(Date.now() - snapshot.eventTime) > 60_000) return [];
    const metrics: SignalEvent['metrics'] = {};
    for (const key of ['price', 'oiBase', 'oiUsd', 'fundingRate', 'volume24hUsd', 'volumeDeltaUsd'] as const) {
      const value = snapshot[key];
      if (value != null && Number.isFinite(value)) metrics[key] = { value, unit: key === 'oiBase' ? 'base' : key === 'fundingRate' ? 'decimal/settlement' : key === 'price' ? 'quote/base' : 'USD' };
    }
    const market = project.markets.find(m => m.exchange === snapshot.exchange && m.symbol === snapshot.symbol);
    if (!market) return [];
    const id = createHash('sha256').update(`${project.id}:${insight.type}:${snapshot.exchange}:${snapshot.symbol}:${Math.floor(snapshot.eventTime / 60_000)}`).digest('hex');
    return [{ schemaVersion: 'nox.signal.v1' as const, id, projectId: project.id, timestamp: insight.timestamp, observedAt: snapshot.eventTime, symbol: { base: market.base, quote: market.quote, native: market.symbol, marketType: market.marketType }, venue: snapshot.exchange, category: insight.type, classification: 'statistical-inference' as const, metrics, evidence: [{ text: [...insight.observed, ...insight.evidence, insight.inferenceNotice].join(' '), sources: [snapshot.source] }], confidence: Math.max(0, Math.min(1, insight.confidence / 100)), severity: 'info' as const, freshness: snapshot.quality }];
  });
}
