import type { MarketProject } from '../shared/types.ts';
import { projectVenueSnapshots } from './exchanges.ts';
import { buildVolumeRecord, fetchSpotLegs } from './volume-matrix.ts';
import type { TimeframeAlignmentResponse } from '../shared/timeframe.ts';
import { OrderFlowService } from './orderflow-service.ts';
import { HistoryStore } from './history-store.ts';
import { evaluateRegimeV2 } from './regime-v2.ts';
import { RegimeRecorder } from './regime-recorder.ts';
import { REGIME_WINDOWS, type RegimeWindow } from '../shared/regime-v2.ts';

export function collectionMode(project: MarketProject) {
  return project.archived || !project.monitoring.streamingEnabled ? 'paused' : project.monitoring.collectionMode ?? 'standard';
}
export class ProjectCollector {
  private active = new Map<string, { signature: string; release: () => void }>();
  private due = new Map<string, number>();
  private states = new Map<string, { checkedAt: number | null; error: string | null; mode: string }>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private projects: () => MarketProject[], private flow: OrderFlowService, private history: HistoryStore, private snapshots = projectVenueSnapshots, private recorder?: RegimeRecorder, private afterSnapshot?: (project:MarketProject)=>void, private spotVolumes = fetchSpotLegs, private alignmentRecorder?: (project: MarketProject) => Promise<TimeframeAlignmentResponse>) {}
  private lastAlignment = new Map<string, number>();
  start() { void this.tick(); this.timer = setInterval(() => void this.tick(), 5000); }
  status() { return [...this.states.entries()].map(([projectId, value]) => ({ projectId, ...value })); }
  tick() {
    if (this.running || this.stopped) return this.running ?? Promise.resolve();
    this.running = this.collect().catch(() => {
      for (const project of this.projects()) this.states.set(project.id, { checkedAt:this.states.get(project.id)?.checkedAt ?? null, mode:collectionMode(project), error:'Project mapping or historical storage failed; retrying without fabricating data' });
    }).finally(() => { this.running = undefined; }); return this.running;
  }
  private async collect() {
    const projects = this.projects();
    await this.history.reconcileProjects(projects);
    for (const [id, current] of this.active) {
      const project = projects.find(p => p.id === id);
      if (!project || collectionMode(project) !== 'active' || current.signature !== JSON.stringify(project.markets)) { current.release(); this.active.delete(id); }
    }
    for (const id of this.states.keys()) if (!projects.some(p => p.id === id)) { this.states.delete(id); this.due.delete(id); }
    await Promise.all(projects.map(async project => {
      const mode = collectionMode(project);
      if (this.states.get(project.id)?.mode !== mode) this.due.delete(project.id);
      if (mode === 'active' && !this.active.has(project.id)) this.active.set(project.id, { signature: JSON.stringify(project.markets), release: this.flow.acquire(project) });
      this.states.set(project.id, { ...(this.states.get(project.id) ?? { checkedAt: null, error: null }), mode });
      if (mode === 'paused' || Date.now() < (this.due.get(project.id) ?? 0)) return;
      this.due.set(project.id, Date.now() + (mode === 'active' ? 30_000 : 300_000));
      try {
        const data = await this.snapshots(project.markets);
        const now = Date.now();
        await Promise.all(data.snapshots.map(snapshot => this.history.append({
          id: `${project.id}:${snapshot.exchange}:${snapshot.marketType}:${snapshot.symbol}:${now}`,
          kind: 'snapshot', marketKey: `${snapshot.exchange}:${snapshot.marketType}:${snapshot.symbol}`,
          projectId: project.id, eventTime: snapshot.eventTime, ingestTime: now,
          source: snapshot.source, quality: snapshot.quality, payload: snapshot,
        })));
        // Persist the per-venue spot/perpetual turnover matrix so share migration can be studied
        // over time. Spot legs are fetched once here; perpetual legs reuse the snapshots above.
        const spotLegs = await this.spotVolumes(project);
        const volumeRecord = buildVolumeRecord(project, spotLegs.legs, spotLegs.failures, data.snapshots, data.failures.map((failure) => ({ ...failure, marketType: 'perpetual' as const, quote: 'USDT' })), now);
        await this.history.append({ id: `${project.id}:volume:${now}`, kind: 'volume', marketKey: `project:${project.id}`, projectId: project.id, eventTime: now, ingestTime: now, source: 'nox.volume-matrix.v1', quality: volumeRecord.claimGate.state === 'available' && !volumeRecord.failures.length ? 'live' : 'partial', payload: volumeRecord });
        // Persist the multi-timeframe alignment claim (auditable timeline of allowed/refused judgments).
        // Optional recorder: production passes timeframeAlignment; tests and offline runs leave it undefined.
        if (this.alignmentRecorder) {
          const cadence = mode === 'active' ? 30_000 : 300_000;
          if (now - (this.lastAlignment.get(project.id) ?? 0) >= cadence) {
            try {
              const alignment = await this.alignmentRecorder(project);
              // Decision is only available after the fetches complete: both eventTime and
              // ingestTime use completion time so outcome entries cannot use an earlier price.
              const completedAt = Date.now();
              this.lastAlignment.set(project.id, completedAt);
              await this.history.append({ id: `${project.id}:alignment:${completedAt}`, kind: 'alignment', marketKey: `project:${project.id}`, projectId: project.id, eventTime: completedAt, ingestTime: completedAt, source: 'nox.timeframe-alignment.v1', quality: 'live', payload: alignment });
            } catch { /* alignment requires an eligible Binance perpetual; skip without fabricating a claim */ }
          }
        }
        if (this.recorder) {
          for (const interval of Object.keys(REGIME_WINDOWS) as RegimeWindow[]) {
            const end=Math.floor((now-90_000)/REGIME_WINDOWS[interval])*REGIME_WINDOWS[interval];
            if(await this.recorder.isRecorded(project.id,interval,end))continue;
            const previous=await this.history.sampleSnapshots(project.id,REGIME_WINDOWS[interval],now);
            await this.recorder.record(evaluateRegimeV2(project,previous,this.flow.snapshot(project,interval,'utc-day',now),interval,now));
          }
        }
        this.states.set(project.id, { checkedAt: now, error: data.failures.length ? `${data.failures.length} venue(s) unavailable; see coverage` : null, mode });
        this.afterSnapshot?.(project);
      } catch { this.states.set(project.id, { ...this.states.get(project.id)!, error: 'Collection failed; missing data not replaced by zero' }); }
    }));
  }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.running; for (const current of this.active.values()) current.release(); this.active.clear(); }
}
