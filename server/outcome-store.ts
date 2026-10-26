import { createHash } from "node:crypto";
import {
  mkdir,
  appendFile,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import type { StudyResponse } from "../shared/event-study.ts";

/** Derived results have an independent versioned journal. Frozen regime files are never edited. */
export class OutcomeStore {
  private queue = Promise.resolve();
  private revisions: Record<string, string> | null = null;
  constructor(private directory: string) {}
  record(study: StudyResponse) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        await mkdir(path.join(this.directory, "outcomes"), { recursive: true });
        const index = path.join(
          this.directory,
          "outcomes",
          "revision-index.json",
        );
        if (!this.revisions) {
          try {
            this.revisions = JSON.parse(await readFile(index, "utf8"));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            this.revisions = {};
          }
        }
        const next = { ...this.revisions };
        let written = 0;
        for (const row of study.rows) {
          if (row.status === "overlap-excluded") continue;
          const revision = createHash("sha256")
              .update(JSON.stringify([study.methodology, row]))
              .digest("hex"),
            key = `${study.methodology}:${row.id}`;
          if (next[key] === revision) continue;
          const file = path.join(
            this.directory,
            "outcomes",
            `${new Date(study.asOf).toISOString().slice(0, 10)}.ndjson`,
          );
          await appendFile(
            file,
            `${JSON.stringify({ id: row.id, revision, methodology: study.methodology, asOf: study.asOf, row })}\n`,
            { mode: 0o600 },
          );
          next[key] = revision;
          written++;
        }
        await writeFile(`${index}.tmp`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${index}.tmp`, index);
        this.revisions = next;
        return written;
      });
    this.queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async close() {
    await this.queue;
  }
}
