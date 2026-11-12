import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { OutcomeStore } from "../server/outcome-store.ts";
import type { StudyResponse } from "../shared/event-study.ts";

const DAY = 86_400_000;
const dateFile = (date: number) => new Date(date).toISOString().slice(0, 10) + ".ndjson";
const study = (id: string, asOf = Date.now()) => ({
  methodology: "nox.event-study.v1", asOf, rows: [{ id, status: "complete", label: id }],
}) as StudyResponse;

function setting(t: TestContext, key: string, value: number) {
  const old = process.env[key];
  process.env[key] = String(value);
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}

async function setup(t: TestContext, bytes: number) {
  setting(t, "NOX_OUTCOME_MAX_BYTES", bytes);
  setting(t, "NOX_STORAGE_MIN_FREE_BYTES", 1);
  const root = await mkdtemp(path.join(tmpdir(), "nox-outcome-retain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, "outcomes"), store: new OutcomeStore(root) };
}

test("a high-volume day rolls and evicts within budget, preserving the latest deduplication after restart", async t => {
  const budget = 3072;
  const { root, directory, store } = await setup(t, budget);
  const count = 40, now = Date.now();
  for (let n = 0; n < count; n++) {
    assert.equal(await store.record(study("study-" + n, now)), 1);
    const filenames = await readdir(directory);
    const sizes = await Promise.all(filenames.map(f => stat(path.join(directory, f))));
    assert.ok(sizes.reduce((total, s) => total + s.size, 0) <= budget);
  }
  assert.ok(store.status().removedSegments > 1);
  await store.close();
  // Simulate abrupt shutdown halfway through the next NDJSON row.
  const file = path.join(directory, dateFile(now));
  const complete = await readFile(file);
  await writeFile(file, Buffer.concat([complete, Buffer.from('{"id":"incomplete')]));
  const restarted = new OutcomeStore(root);
  assert.equal(await restarted.record(study("study-39", now)), 0);
  assert.deepEqual(await readFile(file), complete);
  // Once its backing revision was evicted, this ID no longer lives indefinitely in the index.
  assert.equal(await restarted.record(study("study-0", now)), 1);
  await restarted.close();
});

test("startup drops expired raw and interrupted archive copies before opening an obsolete global index", async t => {
  const { root, directory, store } = await setup(t, 20_000);
  await mkdir(directory);
  const old = dateFile(Date.now() - 50 * DAY);
  const part = old + ".1-2-" + randomUUID();
  const data = Buffer.from("invalid-old-json\n");
  await Promise.all([
    writeFile(path.join(directory, old), data),
    writeFile(path.join(directory, part + ".sealed"), data),
    writeFile(path.join(directory, part + "." + data.length + ".x.x.gz"), gzipSync(data)),
    writeFile(path.join(directory, "revision-checkpoint.json.gz"), "old global index"),
    writeFile(path.join(directory, "revision-index.json"), "obsolete"),
    writeFile(path.join(directory, "revision-index.json.tmp"), "staged by legacy writer"),
    writeFile(path.join(directory, "revision-checkpoint.json.gz." + randomUUID() + ".tmp"), "abandoned"),
    writeFile(path.join(directory, "operator-notes.txt"), "preserve"),
  ]);
  await store.maintain();
  assert.deepEqual(await readdir(directory), ["operator-notes.txt"]);
  assert.equal(await store.record(study("old", Date.now() - 50 * DAY)), 0);
  assert.equal(await store.record(study("new")), 1);
  await store.close();
  const restarted = new OutcomeStore(root);
  assert.equal(await restarted.record(study("new")), 0);
  await restarted.close();
});

test("oversize batches and filesystem reserve skip derived writes without evicting a fitting recent study", async t => {
  const { root, store } = await setup(t, 4096);
  assert.equal(await store.record(study("recent")), 1);
  assert.equal(await store.record(study("oversize".repeat(800))), 0);
  assert.equal(store.status().writePressure, "batch-exceeds-quota");
  assert.equal(await store.record(study("recent")), 0);
  assert.equal(await store.record(study("another")), 1);
  assert.equal(store.status().writePressure, null);
  await store.close();
  setting(t, "NOX_STORAGE_MIN_FREE_BYTES", Number.MAX_SAFE_INTEGER);
  const restarted = new OutcomeStore(root);
  assert.equal(await restarted.record(study("blocked")), 0);
  assert.equal(restarted.status().writePressure, "filesystem-reserve");
  assert.equal(await restarted.record(study("another")), 0);
  assert.equal(restarted.status().skippedRows, 1);
  await restarted.close();
});

test("a backdated revision stays latest on replay; eviction reveals the last surviving revision", async t => {
  setting(t, "NOX_OUTCOME_RETENTION_DAYS", 2);
  const { root, directory, store } = await setup(t, 40_000);
  const now = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
  const earlier = study("same-id", now - DAY);
  earlier.rows[0].label = "written-later";
  const current = study("same-id", now);
  assert.equal(await store.record(current), 1);
  assert.equal(await store.record(earlier), 1);
  await store.close();
  // A zero-headroom rollover can intentionally omit the optional checkpoint.
  await rm(path.join(directory, "revision-checkpoint.json.gz"), { force: true });
  const restarted = new OutcomeStore(root);
  assert.equal(await restarted.record(earlier), 0);
  t.mock.method(Date, "now", () => now + 2 * DAY);
  await restarted.maintain();
  assert.equal(await restarted.record(current), 0);
  await restarted.close();
});
