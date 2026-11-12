import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { HistoryStore, type HistoryEvent } from "../server/history-store.ts";
import type { MarketProject } from "../shared/types.ts";
import { historyPolicy } from "../server/history-policy.ts";

test("lifecycle is disabled by default and validates retention boundaries", () => {
  assert.equal(historyPolicy().statements.length, 0);
  assert.equal(historyPolicy(7, 90).destructive, true);
  assert.throws(() => historyPolicy(30, 7), /Retention/);
  assert.throws(() => historyPolicy(-1, 0), /integers/);
});
test("historical filters preserve gaps, exclude late ingestion and reject corrupt journal tails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-gaps-")),
    store = new HistoryStore(dir);
  await store.init();
  try {
    await store.append(event("earlier", 1000));
    await store.append(event("later", 9000));
    await store.append({ ...event("late-arrival", 2000), ingestTime: 20_000 });
    const page = await store.page("p", {
      kind: "trade",
      from: 1500,
      to: 10_000,
      asOf: 10_000,
    });
    assert.deepEqual(
      page.items.map((e) => e.id),
      ["later"],
    );
    assert.equal(
      (
        await store.page("p", {
          kind: "trade",
          asOf: 10_000,
          marketKey: "bybit:perpetual:TESTUSDT",
        })
      ).items.length,
      0,
    );
    const file = (await readdir(path.join(dir, "history")))[0];
    await appendFile(path.join(dir, "history", file), "{partial");
    await assert.rejects(
      store.read("p", "trade", 30_000),
      /Incomplete journal tail/,
    );
  } finally {
    await store.close();
  }
});

const event = (
  id: string,
  time = 1000,
  projectId: string | null = "p",
): HistoryEvent => ({
  id,
  kind: "trade",
  marketKey: "binance:perpetual:TESTUSDT",
  projectId,
  eventTime: time,
  ingestTime: time,
  source: "fixture",
  quality: "live",
  payload: {},
});
const project = {
  id: "p",
  archived: false,
  markets: [
    { exchange: "binance", marketType: "perpetual", symbol: "TESTUSDT" },
  ],
} as MarketProject;
function database() {
  const state = {
    id: "database-A",
    inserts: 0,
    failCommit: false,
    failRead: false,
    reads: 0,
    queries: [] as string[],
  };
  const query = async (sql: string) => {
    state.queries.push(sql);
    if (sql.startsWith("SELECT hypertable_size")) return { rows: [{ bytes: 0, clock: new Date(2000), floor: null, expired: false }] };
    if (sql.startsWith("SELECT 1 FROM pg_extension"))
      return { rowCount: 1, rows: [{}] };
    if (sql.startsWith("SELECT store_id"))
      return { rows: [{ store_id: state.id }] };
    if (sql.startsWith("INSERT INTO nox_history_events")) state.inserts++;
    if (sql === "COMMIT" && state.failCommit) throw new Error("Commit failed");
    if (sql.includes("FROM nox_history_events e WHERE")) {
      state.reads++;
      if (state.failRead) throw new Error("Query failed");
      return { rows: [event("database-row")] };
    }
    return { rowCount: 0, rows: [] };
  };
  return {
    state,
    pool: {
      on: () => {},
      connect: async () => ({ query, release: () => {} }),
      query,
      end: async () => {},
    } as unknown as Pool,
  };
}
test("daily partitions preserve legacy history, deduplicate and paginate equal timestamps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-pages-")),
    store = new HistoryStore(dir);
  await store.init();
  try {
    await appendFile(
      path.join(dir, "history-trade.ndjson"),
      `${JSON.stringify(event("a"))}\n`,
    );
    for (const id of ["a", "b", "c"]) await store.append(event(id));
    const first = await store.page("p", {
      kind: "trade",
      asOf: 2000,
      limit: 2,
    });
    assert.deepEqual(
      first.items.map((e) => e.id),
      ["c", "b"],
    );
    assert.ok(first.nextCursor);
    await store.append({ ...event("late", 900), ingestTime: 3000 });
    const next = await store.page("p", {
      kind: "trade",
      cursor: first.nextCursor!,
      limit: 2,
    });
    assert.deepEqual(
      next.items.map((e) => e.id),
      ["a"],
    );
    assert.equal(next.asOf, 2000);
    assert.equal(
      (await readdir(path.join(dir, "history")))[0],
      "1970-01-01-trade.ndjson",
    );
    await assert.rejects(
      store.page("p", { kind: "trade", cursor: "broken" }),
      /Invalid/,
    );
    assert.ok((await store.measure()).journalBytes > 0);
  } finally {
    await store.close();
  }
});
test("shared raw feeds map only during recorded project-market membership", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-links-")),
    store = new HistoryStore(dir);
  await store.init();
  await store.reconcileProjects([project], 1000);
  await store.append(event("before", 900, null));
  await store.append(event("during", 1100, null));
  await store.reconcileProjects([], 1200);
  await store.append(event("after", 1300, null));
  assert.deepEqual(
    (await store.read("p", "trade", 2000)).map((e) => e.id),
    ["during"],
  );
  assert.equal((await store.read("other-project", "trade", 2000)).length, 0);
  await store.close();
  const restart = new HistoryStore(dir);
  await restart.init();
  assert.equal((await restart.read("p", "trade", 2000)).length, 1);
  await restart.close();
});
test("database queries are primary; committed byte checkpoints survive restart and new database identity replays", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-checkpoints-")),
    db = database();
  let store = new HistoryStore(dir, undefined, db.pool);
  await store.init();
  await store.append(event("one"));
  await store.sync();
  assert.equal(db.state.inserts, 1);
  const checkpoint = (await readdir(dir)).find((f) =>
    f.startsWith("history-checkpoints-"),
  )!;
  const saved = JSON.parse(await readFile(path.join(dir, checkpoint), "utf8"));
  assert.ok(Object.values(saved.files).length);
  assert.equal(saved.databaseId, "database-A");
  const page = await store.page("p", { kind: "trade", asOf: 2000 });
  assert.equal(page.backend, "timescaledb");
  assert.equal(page.items[0].id, "database-row");
  assert.equal(db.state.inserts, 1);
  await store.close();
  store = new HistoryStore(dir, undefined, db.pool);
  await store.init();
  assert.equal(db.state.inserts, 1);
  await store.append(event("two"));
  await store.sync();
  assert.equal(db.state.inserts, 2);
  db.state.id = "database-B";
  await store.sync();
  assert.equal(db.state.inserts, 4);
  db.state.failRead = true;
  const fallback = await store.page("p", { kind: "trade", asOf: 2000 });
  assert.equal(fallback.backend, "local-journal");
  assert.match(fallback.fallback!, /query failed/);
  assert.equal(fallback.items.length, 2);
  await store.close();
});
test("failed transaction does not advance checkpoint and retries idempotently", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-rollback-")),
    db = database(),
    store = new HistoryStore(dir, undefined, db.pool);
  await store.init();
  await store.append(event("one"));
  db.state.failCommit = true;
  await store.sync();
  assert.equal(store.status().databaseRowsAcknowledged, 0);
  assert.equal(store.status().connected, false);
  assert.ok(db.state.queries.includes("ROLLBACK"));
  db.state.failCommit = false;
  await store.sync();
  assert.equal(store.status().databaseRowsAcknowledged, 1);
  await store.close();
});

test("daily L2 journals are read locally and included in database replication", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nox-l2-history-"));
  const local = new HistoryStore(dir);
  await local.init();
  try {
    await local.append({ ...event("l2-bucket"), kind: "l2" });
    const page = await local.page("p", { kind: "l2", asOf: 2000 });
    assert.deepEqual(page.items.map((item) => item.id), ["l2-bucket"]);
  } finally {
    await local.close();
  }

  const db = database();
  const replica = new HistoryStore(dir, undefined, db.pool);
  await replica.init();
  try {
    assert.equal(replica.status().connected, true);
    assert.equal(replica.status().databaseRowsAcknowledged, 1);
    assert.equal(db.state.inserts, 1);
  } finally {
    await replica.close();
  }
});

test(
  "real TimescaleDB: migrations, market mapping, indexed query and restart recovery",
  { skip: !process.env.NOX_TEST_DATABASE_URL },
  async () => {
    const url = process.env.NOX_TEST_DATABASE_URL!,
      schema = `nox_test_${crypto.randomUUID().replaceAll("-", "")}`,
      admin = new Pool({ connectionString: url });
    const extension = await admin.query(
      "SELECT 1 FROM pg_extension WHERE extname='timescaledb'",
    );
    assert.equal(
      extension.rowCount,
      1,
      "Install TimescaleDB on the dedicated test database",
    );
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = {
      connectionString: url,
      options: `-c search_path=${schema},public`,
    };
    let store: HistoryStore | undefined;
    try {
      const migrationPool = new Pool(options);
      for (const file of ["003_history.sql", "004_history_queries.sql"])
        await migrationPool.query(
          await readFile(
            new URL(`../db/migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      await migrationPool.query(`INSERT INTO nox_history_events(id,kind,market_key,event_time,ingest_time,source,quality,payload)
        VALUES ('expired','trade','x',now()-interval '400 days',now(),'fixture','live','{}')`);
      await migrationPool.end();
      const dir = await mkdtemp(path.join(tmpdir(), "nox-timescale-"));
      store = new HistoryStore(dir, url, new Pool(options));
      await store.init();
      assert.equal(store.status().timescaleRetention?.paused, null);
      assert.equal((await admin.query(`SELECT 1 FROM ${schema}.nox_history_events WHERE id='expired'`)).rowCount, 0);
      assert.ok((await admin.query(`SELECT retained_from FROM ${schema}.nox_history_storage_meta`)).rows[0].retained_from);
      const start = Date.now() - 2000;
      await store.reconcileProjects([project], start);
      await store.append(event("real", start + 100, null));
      const result = await store.page("p", { kind: "trade", asOf: start + 1000 });
      assert.equal(result.backend, "timescaledb");
      assert.equal(result.items[0].id, "real");
      const link = async () => (await admin.query(
        `SELECT xmin::text AS revision, valid_to FROM ${schema}.nox_project_market_links WHERE project_id = $1`,
        [project.id],
      )).rows[0];
      const open = await link();
      assert.equal(open.valid_to, null);
      await store.sync();
      assert.deepEqual(await link(), open);
      await store.reconcileProjects([], start + 200);
      await store.sync();
      const closed = await link();
      assert.equal(closed.valid_to.getTime(), start + 200);
      assert.notEqual(closed.revision, open.revision);
      await store.sync();
      assert.deepEqual(await link(), closed);
      // A restored database can lack a link even when it retains the same store ID.
      await admin.query(`DELETE FROM ${schema}.nox_project_market_links WHERE project_id = $1`, [project.id]);
      await store.sync();
      assert.equal((await link()).valid_to.getTime(), start + 200);
      await store.close();
      store = new HistoryStore(dir, url, new Pool(options));
      await store.init();
      assert.equal(store.status().databaseRowsAcknowledged, 1);
      assert.equal(
        (await store.page("p", { kind: "trade", asOf: start + 1000 })).items.length,
        1,
      );
    } finally {
      await store?.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("closed journal gzip preserves read offsets, replication and late arrivals to a sealed day", async () => {
  const { archiveClosedJournals, journalBytes, journalSegments } = await import('../server/journal-archive.ts');
  const { utimes, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-journal-gzip-'));
  const daily = path.join(dir, 'history'), db = database(), kind = (name: string) => name.endsWith('-trade.ndjson');
  const store = new HistoryStore(dir, undefined, db.pool);
  try {
    await store.init();
    const rows = Array.from({length: 40}, (_,index) => ({...event('ordered-' + index, 1000 + index), payload:{ message:'sample'.repeat(100) }}));
    const acknowledgements = rows.map(row => store.append(row));
    assert.equal(new Set(acknowledgements).size, 1);
    await Promise.all(acknowledgements);
    await store.sync();
    assert.equal(db.state.inserts, rows.length);
    await utimes(path.join(daily, '1970-01-01-trade.ndjson'), new Date(0), new Date(0));
    const [original] = await journalSegments(daily, kind);
    const plain = await readFile(original.file);
    await archiveClosedJournals(daily, kind, {indexTime:true});
    const [archive] = await journalSegments(daily, kind);
    assert.equal(archive.compressed, true);
    assert.ok(archive.storedBytes < archive.size / 4);
    assert.deepEqual([archive.minTime, archive.maxTime], [1000, 1039]);
    const tail: Buffer[] = [];
    for await (const chunk of journalBytes(original, 97)) tail.push(chunk);
    assert.deepEqual(Buffer.concat(tail), plain.subarray(97));
    // archive and new raw name share the date but have independent checkpoints.
    await store.append(event('late', 2000));
    await store.sync();
    assert.equal(db.state.inserts, rows.length + 1);
    const measured = await store.measure();
    assert.equal(measured.pendingBytes, 0);
    assert.ok(measured.journalBytes < plain.length / 3);
    db.state.failRead = true;
    const fallback = await store.page('p', {kind:'trade', from:1010, to:2000, limit:100});
    assert.equal(fallback.items.length, 31);
    assert.equal(fallback.items[0].id, 'late');
    db.state.id = 'db-rebuilt';
    await store.sync();
    assert.equal(db.state.inserts, 2 * (rows.length + 1));
  } finally {
    await store.close();
    await rm(dir, {recursive:true, force:true});
  }
});

test("archive staging reserves live space and keeps incompressible originals readable", async () => {
  const { archiveByteBudget, archiveClosedJournals, journalBytes, journalSegments } = await import('../server/journal-archive.ts');
  const { utimes, writeFile, rm } = await import('node:fs/promises');
  const {storageReserveBytes} = await import('../server/storage-limits.ts');
  const reserve = storageReserveBytes();
  assert.equal(archiveByteBudget(500, reserve - 1), 0);
  assert.equal(archiveByteBudget(500, reserve + 121), 121);
  assert.equal(archiveByteBudget(500, reserve * 2), 499);
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-keep-raw-'));
  const file = path.join(dir, '2000-01-01-trade.ndjson');
  try {
    await writeFile(file, '{}\n');
    await utimes(file, new Date(0), new Date(0));
    await archiveClosedJournals(dir, name => name.endsWith('.ndjson'));
    const items = await journalSegments(dir, name => name.endsWith('.ndjson'));
    assert.equal(items.length, 1);
    assert.equal(items[0].compressed, false);
    const buffers = [];
    for await (const chunk of journalBytes(items[0])) buffers.push(chunk);
    assert.equal(Buffer.concat(buffers).toString(), '{}\n');
    assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
