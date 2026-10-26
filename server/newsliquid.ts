import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { SignalEvent } from '../shared/research.ts';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXCHANGE_IDS } from '../shared/types.ts';

export interface PublishAudit { id: string; at: number; state: 'disabled' | 'dry-run' | 'retry' | 'sent' | 'duplicate' | 'failed'; attempt: number; mode: 'test' }
interface Options { enabled: boolean; appId?: string; secret?: string; transport?: typeof fetch; audit: (entry: PublishAudit) => Promise<void>; sleep?: (ms: number) => Promise<void>; sentIds?: string[] }
const PUBLIC_METRICS = new Set(['price', 'oiBase', 'oiUsd', 'fundingRate', 'volume24hUsd', 'volumeDeltaUsd']);
export function publicPayload(event: SignalEvent) {
  // Explicit allowlist: never forward arbitrary evidence, project metadata, addresses, or user research.
  if (!EXCHANGE_IDS.includes(event.venue) || !/^[A-Z0-9][A-Z0-9_.:/-]{0,49}$/.test(event.symbol.native) || /^0x[0-9a-f]{40}$/i.test(event.symbol.native)) throw new Error('Unverified public market identity');
  const metrics = Object.fromEntries(Object.entries(event.metrics).filter(([key, metric]) => PUBLIC_METRICS.has(key) && Number.isFinite(metric.value)).map(([key, metric]) => [key, { value: metric.value, unit: key === 'oiBase' ? 'base' : key === 'fundingRate' ? 'decimal/settlement' : key === 'price' ? 'quote/base' : 'USD' }]));
  return { id: `nox-test-${createHash('sha256').update(event.id).digest('hex')}`, text: `NOX public market observation: ${event.venue} ${event.symbol.native}`, ts: new Date(event.timestamp).toISOString(), test: true, meta: { venue: event.venue, symbol: event.symbol.native, metrics, confidence: Math.max(0, Math.min(1, event.confidence)), severity: ['info', 'warning', 'critical'].includes(event.severity) ? event.severity : 'info', observedAt: event.observedAt, classification: 'statistical-inference' } };
}
export function signSignal(secret: string, timestamp: string, nonce: string, body: string) { return createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${body}`).digest('hex'); }

// Test-only transport. No live-publishing path is exposed by the application.
export class NewsLiquidAdapter {
  private sent = new Set<string>();
  private pending = new Set<string>();
  constructor(private options: Options) { this.sent = new Set(options.sentIds); }
  async publish(event: SignalEvent, dryRun = true): Promise<PublishAudit['state']> {
    const log = async (state: PublishAudit['state'], attempt = 0) => { await this.options.audit({ id: event.id, at: Date.now(), state, attempt, mode: 'test' }); return state; };
    if (!this.options.enabled) return log('disabled');
    if (dryRun) { publicPayload(event); return log('dry-run'); }
    if (!this.options.appId || !/^[a-zA-Z0-9_-]+$/.test(this.options.appId) || !this.options.secret) throw new Error('Missing or invalid server-side publisher configuration');
    if (this.sent.has(event.id) || this.pending.has(event.id)) return log('duplicate');
    this.pending.add(event.id);
    try {
      const body = JSON.stringify(publicPayload(event));
      for (let attempt = 1; attempt <= 3; attempt++) {
        const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
        try {
          const response = await (this.options.transport ?? fetch)(`https://news-api.newsliquid.com/api/v2/signal-sources/push/${this.options.appId}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signal-Timestamp': timestamp, 'X-Signal-Nonce': nonce, 'X-Signal-Signature': signSignal(this.options.secret, timestamp, nonce, body) }, body, signal: AbortSignal.timeout(15_000) });
          if (response.ok) {
            const json = await response.json(); const result = json.data ?? json;
            if (result.test !== true || result.queued !== false) return log('failed', attempt);
            await log('sent', attempt); this.sent.add(event.id); return 'sent';
          }
          if (response.status !== 429 && response.status < 500) return log('failed', attempt);
        } catch { /* Ambiguous responses retry the same stable event ID. */ }
        if (attempt < 3) { await log('retry', attempt); await (this.options.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms))))(250 * 2 ** attempt); }
      }
      return log('failed', 3);
    } finally { this.pending.delete(event.id); }
  }
}

export async function configuredNewsLiquidAdapter(directory: string) {
  const file = path.join(directory, 'signal-publishing-audit.jsonl');
  let entries: PublishAudit[] = [];
  try { entries = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return new NewsLiquidAdapter({ enabled: process.env.NOX_NEWSLIQUID_ENABLED === 'true', appId: process.env.NEWSLIQUID_APP_ID, secret: process.env.NEWSLIQUID_APP_SECRET, sentIds: entries.filter(e => e.state === 'sent').map(e => e.id), audit: async entry => {
    await mkdir(directory, { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } });
}
