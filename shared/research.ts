import type { ExchangeId, Quality } from './types.ts';

export interface ResearchClaim { text: string; sources: string[] }
export interface ResearchReport {
  generatedAt: number; projectId: string; mode: 'evidence-only' | 'ai-assisted';
  observed: ResearchClaim[]; inferences: ResearchClaim[]; hypotheses: ResearchClaim[]; limitations: ResearchClaim[];
  sources: Array<{ id: string; venue: ExchangeId; symbol: string; source: string; eventTime: number; quality: Quality }>;
  tools: string[];
}
export interface SignalEvent {
  schemaVersion: 'nox.signal.v1'; id: string; projectId: string; timestamp: number; observedAt: number;
  symbol: { base: string; quote: string; native: string; marketType: 'spot' | 'perpetual' };
  venue: ExchangeId; category: string; classification: 'statistical-inference';
  metrics: Record<string, { value: number; unit: string }>;
  evidence: ResearchClaim[]; confidence: number; severity: 'info' | 'warning' | 'critical'; freshness: Quality;
}
