import type { MarketProject } from '../shared/types.ts';
import { projectVenueSnapshots } from './exchanges.ts';
import { buildVolumeRecord, fetchSpotLegs } from './volume-matrix.ts';
import type { TimeframeAlignmentResponse } from '../shared/timeframe.ts';
import { OrderFlowService } from './orderflow-service.ts';
import { HistoryStore } from './history-store.ts';
import { evaluateRegimeV2 } from './regime-v2.ts';
import { RegimeRecorder } from './regime-recorder.ts';
import { REGIME_WINDOWS, type RegimeReport, type RegimeWindow } from '../shared/regime-v2.ts';
import { CollectorCapture } from './collector-capture.ts';
import { flowKey } from './orderflow-calculations.ts';

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
  private captures = new Map<string, CollectorCapture>();
  start() { void this.tick(); this.timer = setInterval(() => void this.tick(), 5000); }
  status() { return [...this.states.entries()].map(([projectId, value]) => ({ projectId, ...value })); }
  tick() {
    if (this.running || this.stopped) return this.running ?? Promise.resolve();
    this.running = this.collect().finally(() => this.recorder?.flush()).catch(() => {
      for (const project of this.projects()) this.states.set(project.id, { checkedAt:this.states.get(project.id)?.checkedAt ?? null, mode:collectionMode(project), error:'Project mapping or historical storage failed; retrying without fabricating data' });
    }).finally(() => { this.running = undefined; }); return this.running;
  }
  private async collect() {
    const projects = this.projects();
    await this.history.reconcileProjects(projects);
    // This list includes archived and paused projects. Only deleted project IDs are obsolete.
    const projectIds = new Set(projects.map(project => project.id));
    if (this.recorder) await this.recorder.reconcileProjects(projectIds).catch(() => {
      // Retry hint cleanup next tick. An index write failure must not stop market collection.
    });
    for (const [id, current] of this.active) {
      const project = projects.find(p => p.id === id);
      if (!project || collectionMode(project) !== 'active' || current.signature !== JSON.stringify(project.markets)) { current.release(); this.active.delete(id); }
    }
    for (const id of this.states.keys()) if (!projectIds.has(id)) {
      this.states.delete(id); this.due.delete(id); this.captures.delete(id);
    }
    await Promise.all(projects.map(async project => {
      const mode = collectionMode(project);
      if (this.states.get(project.id)?.mode !== mode) this.due.delete(project.id);
      if (mode === 'active' && !this.active.has(project.id)) this.active.set(project.id, { signature: JSON.stringify(project.markets), release: this.flow.acquire(project) });
      this.states.set(project.id, { ...(this.states.get(project.id) ?? { checkedAt: null, error: null }), mode });
      if (mode === 'paused' || Date.now() < (this.due.get(project.id) ?? 0)) return;
      this.due.set(project.id, Date.now() + (mode === 'active' ? 30_000 : 300_000));
      try {
        const markets = [...new Map(project.markets.map(market => [flowKey(market), market])).values()];
        const data = await this.snapshots(markets);
        const now = Date.now();
        let capture = this.captures.get(project.id);
        if (!capture) { capture = new CollectorCapture(project.id, this.history); this.captures.set(project.id, capture); }
        capture.retainMarkets(project.markets);
        const snapshots = await Promise.allSettled(data.snapshots.map(snapshot => capture.snapshot(snapshot, mode, now)));
        const failed = snapshots.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        await capture.periodic('volume', mode, now, async () => {
          const spotLegs = await this.spotVolumes(project);
          const at = Date.now();
          const volume = buildVolumeRecord(project, spotLegs.legs, spotLegs.failures, data.snapshots,
            data.failures.map(failure => ({ ...failure, marketType: 'perpetual' as const, quote: 'USDT' })), at);
          return { id: `${project.id}:volume:${at}`, kind: 'volume', marketKey: `project:${project.id}`, projectId: project.id,
            eventTime: at, ingestTime: at, source: 'nox.volume-matrix.v1',
            quality: volume.claimGate.state === 'available' && !volume.failures.length ? 'live' : 'partial', payload: volume };
        });
        const observeAlignment = this.alignmentRecorder;
        if (observeAlignment) {
          await capture.periodic('alignment', mode, Date.now(), async () => {
            const alignment = await observeAlignment(project).catch(() => null);
            if (!alignment) return null; // Unsupported venues do not produce a decision.
            // The decision becomes available when its inputs finish loading.
            const at = Date.now();
            return { id: `${project.id}:alignment:${at}`, kind: 'alignment', marketKey: `project:${project.id}`, projectId: project.id,
              eventTime: at, ingestTime: at, source: 'nox.timeframe-alignment.v1', quality: 'live', payload: alignment };
          });
        }
        if (this.recorder) {
          const reports: RegimeReport[] = [];
          try {
            for (const interval of Object.keys(REGIME_WINDOWS) as RegimeWindow[]) {
              const end=Math.floor((now-90_000)/REGIME_WINDOWS[interval])*REGIME_WINDOWS[interval];
              if(await this.recorder.isRecorded(project.id,interval,end))continue;
              const previous=await this.history.sampleSnapshots(project.id,REGIME_WINDOWS[interval],now);
              reports.push(evaluateRegimeV2(project,previous,this.flow.snapshot(project,interval,'utc-day',now),interval,now));
            }
          } finally {
            if (reports.length) await this.recorder.recordBatch(reports);
          }
        }
        this.states.set(project.id, { checkedAt: now, error: data.failures.length ? `${data.failures.length} venue(s) unavailable; see coverage` : null, mode });
        this.afterSnapshot?.(project);
      } catch { this.states.set(project.id, { ...this.states.get(project.id)!, error: 'Collection failed; missing data not replaced by zero' }); }
    }));
  }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.running; for (const current of this.active.values()) current.release(); this.active.clear(); await this.recorder?.flush(); }
}
