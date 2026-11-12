import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Pool } from "pg";
import { HistoryStore, type HistoryEvent } from "../server/history-store.ts";

const now = Date.now();
const plain = new Date(now).toISOString().slice(0, 10) + "-trade.ndjson";
const event = (id: string): HistoryEvent => ({
  id, kind: "trade", marketKey: "binance:perpetual:TESTUSDT", projectId: "p",
  eventTime: now, ingestTime: now, source: "test", quality: "live", payload: {},
});

function database() {
  const inserts: string[] = [];
  async function query(sql: string, params: string[] = []) {
    if (sql.startsWith("SELECT hypertable_size")) return { rows: [{ bytes: 0, clock: new Date(2000), floor: null, expired: false }] };
    if (sql.startsWith("SELECT 1 FROM pg_extension")) return { rowCount: 1 };
    if (sql.startsWith("SELECT store_id")) return { rows: [{ store_id: "test" }] };
    if (sql.startsWith("INSERT INTO nox_history_events"))
      for (let i = 0; i < params.length; i += 9) inserts.push(params[i]);
    return { rows: [] };
  }
  const pool = { on() {}, end() {}, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  return { inserts, pool };
}

test('a same-sized raw replacement replays before retirement with a legacy inode-only checkpoint', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-checkpoint-legacy-"));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const db = database(), first = new HistoryStore(dir, undefined, db.pool);
  await first.init();
  await first.append(event("old"));
  await first.close();
  const cp = path.join(dir, (await readdir(dir)).find(name => name.startsWith("history-checkpoints-"))!);
  const saved = JSON.parse(await readFile(cp, "utf8"));
  delete saved.files["history/" + plain].birth;
  await writeFile(cp,JSON.stringify(saved));
  await writeFile(path.join(dir,"history",plain),JSON.stringify(event("new"))+"\n");
  const restored = new HistoryStore(dir, undefined, db.pool);
  try {
    await restored.init();
    assert.deepEqual(db.inserts, ["old", "new"]);
    await restored.sync();
    assert.equal(db.inserts.length, 2);
  } finally { await restored.close(); }
});

for (const reuse of [false, true]) {
  test(reuse ? "an ambiguous legacy inode replays both generations exactly once" :
    "a complete checkpoint follows rotation on disk even without a new event", async t => {
    const dir = await mkdtemp(path.join(tmpdir(), "nox-checkpoint-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { inserts, pool } = database();
    const first = new HistoryStore(dir, undefined, pool);
    await first.init();
    await first.append(event("old"));
    await first.close();
    const file = path.join(dir, "history", plain);
    const bytes = await readFile(file);
    const { dev, ino } = await stat(file);
    const key = plain + "." + dev + "-" + ino + "-" + randomUUID();
    // Keeping the raw inode and replacing its contents deterministically simulates inode reuse.
    await writeFile(path.join(path.dirname(file), key + "." + bytes.length + ".x.x.gz"), gzipSync(bytes));
    const late = ["late1", "late2"].map(id => JSON.stringify(event(id)) + "\n").join("");
    if (reuse) await writeFile(file, late);
    else await rm(file);
    inserts.length = 0;

    const second = new HistoryStore(dir, undefined, pool);
    try {
      await second.init();
      // Startup measures again after replication and retention finish.
      assert.equal(second.status().capacity?.pendingBytes, 0);
      assert.deepEqual(inserts, reuse ? ["old", "late1", "late2"] : []);
      await second.sync();
      assert.equal(second.status().connected, true);
      assert.deepEqual(inserts, reuse ? ["old", "late1", "late2"] : []);
      assert.equal((await second.measure()).pendingBytes, 0);
      const cpFile = (await readdir(dir)).find(f => f.startsWith("history-checkpoints-"))!;
      const saved = JSON.parse(await readFile(path.join(dir, cpFile), "utf8")).files;
      assert.equal(saved["history/" + key].offset, bytes.length);
      assert.equal(saved["history/" + plain]?.offset, reuse ? Buffer.byteLength(late) : undefined);
    } finally {
      await second.close();
    }
  });
}
