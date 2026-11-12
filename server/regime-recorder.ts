import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { RegimeReport } from "../shared/regime-v2.ts";
import { HistoryStore } from "./history-store.ts";

/** Freeze first observations. Recover from history before writing so a crash between journal/index writes is safe. */
export class RegimeRecorder {
  private queue = Promise.resolve();
  private loaded = false;
  private last: Record<string, number> = {};
  constructor(
    private directory: string,
    private history: HistoryStore,
  ) {}
  async isRecorded(projectId: string, interval: string, end: number) {
    await this.queue;
    if (!this.loaded) {
      try {
        this.last = JSON.parse(
          await readFile(
            path.join(this.directory, "regime-v2-windows.json"),
            "utf8",
          ),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      this.loaded = true;
    }
    return (this.last[`${projectId}:${interval}`] ?? -1) >= end;
  }
  record(report: RegimeReport) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.directory, "regime-v2-windows.json");
        if (!this.loaded) {
          try {
            this.last = JSON.parse(await readFile(file, "utf8"));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          this.loaded = true;
        }
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
        const next = { ...this.last, [key]: report.windowEnd };
        await mkdir(this.directory, { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        this.last = next;
        return true;
      });
    this.queue = work.then(() => {}, () => {});
    return work;
  }
}
