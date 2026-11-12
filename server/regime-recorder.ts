import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { RegimeReport } from "../shared/regime-v2.ts";
import { HistoryStore } from "./history-store.ts";

/** Freeze first observations. Recover from history before writing so a crash between journal/index writes is safe. */
export class RegimeRecorder {
  private queue = Promise.resolve();
  private loaded = false;
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
  private async save(next: Record<string, number>) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
    this.last = next;
  }
  isRecorded(projectId: string, interval: string, end: number) {
    return this.run(() => (this.last[`${projectId}:${interval}`] ?? -1) >= end);
  }
  reconcileProjects(projectIds: ReadonlySet<string>) {
    return this.run(async () => {
      // These are latest-window hints. The frozen reports live in HistoryStore.
      const obsolete = Object.keys(this.last).filter(key =>
        !projectIds.has(key.slice(0, key.lastIndexOf(":"))));
      if (!obsolete.length) return;
      const next = { ...this.last };
      for (const key of obsolete) delete next[key];
      await this.save(next);
    });
  }
  record(report: RegimeReport) {
    return this.run(async () => {
      const key = `${report.projectId}:${report.interval}`;
      if ((this.last[key] ?? -1) >= report.windowEnd) return false;
      const existing = await this.history.page(report.projectId, {
        kind: "regime",
        id: report.id,
        from: report.windowEnd,
        limit: 1,
      });
      if (!existing.items.length)
        await this.history.append({
          id: report.id,
          kind: "regime",
          projectId: report.projectId,
          marketKey: "project",
          eventTime: report.decisionTime,
          ingestTime: Date.now(),
          source: report.version,
          quality:
            report.coveredVenues === report.requestedVenues
              ? "live"
              : "partial",
          payload: report,
        });
      await this.save({ ...this.last, [key]: report.windowEnd });
      return true;
    });
  }
}
