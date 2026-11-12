import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { RegimeReport } from "../shared/regime-v2.ts";
import { HistoryStore } from "./history-store.ts";

/** Freeze first observations. Recover from history before writing so a crash between journal/index writes is safe. */
export class RegimeRecorder {
  private queue = Promise.resolve();
  private loaded = false;
  private dirty = false;
  private readonly startedAt = Date.now();
  private last: Record<string, number> = {};
  private readonly file: string;
  constructor(
    private directory: string,
    private history: HistoryStore,
  ) { this.file = path.join(directory, "regime-v2-windows.json"); }
  private run<T>(work: () => T | Promise<T>) {
    const result = this.queue.then(async () => {
      if (!this.loaded) {
        try { this.last = JSON.parse(await readFile(this.file, "utf8")); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        this.loaded = true;
      }
      return work();
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  flush() {
    return this.run(async () => {
      if (!this.dirty) return;
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(this.last), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.dirty = false;
    });
  }
  isRecorded(projectId: string, interval: string, end: number) {
    return this.run(() => (this.last[`${projectId}:${interval}`] ?? -1) >= end);
  }
  reconcileProjects(projectIds: ReadonlySet<string>) {
    return this.run(() => {
      // These are latest-window hints. The frozen reports live in HistoryStore.
      const obsolete = Object.keys(this.last).filter(key =>
        !projectIds.has(key.slice(0, key.lastIndexOf(":"))));
      if (!obsolete.length) return;
      for (const key of obsolete) delete this.last[key];
      this.dirty = true;
    });
  }
  async record(report: RegimeReport) {
    const changed = await this.recordBatch([report]);
    await this.flush();
    return changed > 0;
  }
  /** All reports are durable before their hints become visible to another collector task. */
  recordBatch(reports: RegimeReport[]) {
    return this.run(async () => {
      const ends = new Map<string, number>();
      const fresh: RegimeReport[] = [];
      let uncertain = false;
      for (const report of reports) {
        const key = `${report.projectId}:${report.interval}`;
        if ((ends.get(key) ?? this.last[key] ?? -1) >= report.windowEnd) continue;
        const existing = await this.history.page(report.projectId, {
          kind: "regime", id: report.id, from: report.windowEnd, limit: 1,
        });
        if (!existing.items.length) {
          // After a crash the database can contain a frozen window whose local copy was
          // retired before the hint was published. A degraded read cannot prove absence.
          // The evaluator first makes a closed window available 90 seconds after its end.
          if (existing.fallback && report.windowEnd + 90_000 <= this.startedAt) {
            uncertain = true;
            continue;
          }
          fresh.push(report);
        }
        ends.set(key, report.windowEnd);
      }
      // Concurrent admissions use the journal's existing bounded per-partition batches.
      // On partial failure leave hints untouched; the next attempt checks each durable ID.
      const writes = await Promise.allSettled(fresh.map(report => this.history.append({
        id: report.id, kind: "regime", projectId: report.projectId, marketKey: "project",
        eventTime: report.decisionTime, ingestTime: Date.now(), source: report.version,
        quality: report.coveredVenues === report.requestedVenues ? "live" : "partial",
        payload: report,
      })));
      const failed = writes.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      for (const [key, end] of ends) this.last[key] = end;
      if (ends.size) this.dirty = true;
      if (uncertain) throw new Error("History recovery required to verify a previous regime window");
      return ends.size;
    });
  }
}
