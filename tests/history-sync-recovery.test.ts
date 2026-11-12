import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Pool} from 'pg';
import {HistoryStore, type HistoryEvent} from '../server/history-store.ts';
import type {MarketProject} from '../shared/types.ts';

const now = Date.now(), yesterday = now - 86_400_000;
function event(id: string, kind: HistoryEvent['kind'] = 'trade', time = now): HistoryEvent {
  return {id,kind,eventTime:time,ingestTime:time,marketKey:'m',projectId:'p',source:'test',quality:'live',payload:{}};
}
const line = (e: HistoryEvent) => JSON.stringify(e) + '\n';
const filename = (e: HistoryEvent) => new Date(e.ingestTime).toISOString().slice(0,10) + '-' + e.kind + '.ndjson';
async function directory(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(),'history-recovery-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  return dir;
}
function database() {
  const rows = new Map<string, HistoryEvent>();
  let transaction: HistoryEvent[] = [];
  const state = {id:'db',online:true,reject:'',inserts:0,queries:[] as string[],missingLink:true,
    beforeLinkWrite: undefined as (() => Promise<void>) | undefined,
    afterSelect: undefined as (() => Promise<void>) | undefined,
    afterCommit: undefined as (() => void) | undefined};
  async function query(sql: string, params: unknown[] = []) {
    state.queries.push(sql);
    if (sql.includes('FROM pg_extension')) return {rowCount:1};
    if (sql.startsWith('SELECT store_id')) return {rows:[{store_id:state.id}]};
    if (sql.startsWith('SELECT hypertable_size')) return {rows:[{bytes:0,clock:new Date(now)}]};
    if (sql.startsWith('SELECT l.project_id')) return {rows:state.missingLink ? [{}] : []};
    if (sql.startsWith('INSERT INTO nox_project_market_links')) {
      await state.beforeLinkWrite?.();
      state.missingLink = false;
    }
    if (sql.startsWith('INSERT INTO nox_history_events')) {
      let rowCount = 0;
      for (let i=0; i<params.length; i+=9) {
        const e = event(String(params[i]), params[i+1] as HistoryEvent['kind'], Number(params[i+4]));
        if (e.id === state.reject) throw Object.assign(new Error('private rejected payload'), {code:'22P02'});
        if (!rows.has(e.id) && !transaction.some(row => row.id === e.id)) {
          transaction.push(e);
          rowCount++;
        }
        state.inserts++;
      }
      return {rows:[],rowCount};
    }
    if (sql === 'COMMIT') {
      for (const row of transaction) rows.set(row.id,row);
      state.afterCommit?.();
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') transaction = [];
    if (sql.includes('FROM nox_history_events e WHERE')) {
      const snapshot = [...rows.values()].filter(e => e.kind === params[0]);
      await state.afterSelect?.();
      return {rows:snapshot};
    }
    return {rows:[]};
  }
  const pool = {on(){},end(){},query,connect:async () => {
    if (!state.online) throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});
    return {query,release(){}};
  }} as unknown as Pool;
  return {pool,state,rows};
}

test('an offline restart preserves every byte; verified checkpoints reclaim space while a torn partition is still pending', async t => {
  const dir = await directory(t), db = database(), old = event('confirmed','trade',yesterday);
  const oldPath = path.join(dir,'history',filename(old));
  const first = new HistoryStore(dir,undefined,db.pool);
  await first.init();
  await first.append(old);
  await first.close();
  const good = event('good-prefix','l2'), healthy = event('healthy');
  const brokenPath = path.join(dir,'history',filename(good)), broken = line(good) + '{"torn"';
  await writeFile(brokenPath, broken);
  await writeFile(path.join(dir,'history',filename(healthy)),line(healthy));
  const previous = process.env.NOX_JOURNAL_MAX_BYTES;
  process.env.NOX_JOURNAL_MAX_BYTES = String(Buffer.byteLength(broken + line(healthy)));
  t.after(() => { if (previous === undefined) delete process.env.NOX_JOURNAL_MAX_BYTES; else process.env.NOX_JOURNAL_MAX_BYTES = previous; });
  db.state.online = false;
  const store = new HistoryStore(dir,undefined,db.pool);
  try {
    await store.init();
    assert.equal(await readFile(oldPath,'utf8'),line(old));
    assert.match(store.status().error!,/connecting.*ECONNREFUSED/);
    db.state.online = true;
    await store.sync();
    assert.equal(store.status().connected,true);
    assert.match(store.status().error!,/Incomplete journal tail.*byte/);
    assert.deepEqual([...db.rows.keys()].sort(),['confirmed','good-prefix','healthy']);
    assert.equal((await store.measure()).pendingBytes,Buffer.byteLength('{"torn"'));
    await assert.rejects(readFile(oldPath),{code:'ENOENT'});
    assert.equal(await readFile(brokenPath,'utf8'),broken);
    const page = await store.page('p',{kind:'l2'});
    assert.deepEqual(page.items.map(e=>e.id),['good-prefix']);
    assert.match(page.fallback!,/Incomplete journal tail/);
  } finally { await store.close(); }
});

test('a new append preserves the incomplete generation and drains its successor', async t => {
  const dir = await directory(t), db = database(), store = new HistoryStore(dir,undefined,db.pool);
  await store.init();
  try {
    const before = event('before'), after = event('after');
    await store.append(before);
    const name = filename(before), file = path.join(dir,'history',name);
    await appendFile(file,'unfinished');
    await store.append(after);
    await store.sync();
    const sealed = (await readdir(path.dirname(file))).find(f=>f.startsWith(name+'.') && f.endsWith('.sealed'))!;
    assert.equal(await readFile(path.join(path.dirname(file),sealed),'utf8'),line(before)+'unfinished');
    assert.equal(await readFile(file,'utf8'),line(after));
    assert.deepEqual([...db.rows.keys()].sort(),['after','before']);
    assert.equal((await store.measure()).pendingBytes,'unfinished'.length);
  } finally { await store.close(); }
});

test('a fully acknowledged current-day raw file is reclaimed even if its feed stops writing', async t => {
  const dir = await directory(t), db = database();
  const raw = event('stopped-feed'), bad = event('pending','l2'), head = line(raw);
  const before = process.env.NOX_JOURNAL_MAX_BYTES;
  process.env.NOX_JOURNAL_MAX_BYTES = String(Buffer.byteLength(line(bad) + 'torn') + 1);
  t.after(() => { if (before === undefined) delete process.env.NOX_JOURNAL_MAX_BYTES; else process.env.NOX_JOURNAL_MAX_BYTES = before; });
  const historyDir = path.join(dir,'history');
  const local = new HistoryStore(dir,undefined,db.pool);
  db.state.online = false;
  await local.init();
  try {
    await writeFile(path.join(historyDir,filename(raw)),head);
    await writeFile(path.join(historyDir,filename(bad)),line(bad)+'torn');
    await local.measure();
    await local.sync();
    assert.equal(local.status().capacity?.acknowledgedFileBytes,null);
    assert.equal(await readFile(path.join(historyDir,filename(raw)),'utf8'),head);
    db.state.online = true;
    await local.sync();
    assert.ok(db.rows.has(raw.id));
    await assert.rejects(readFile(path.join(historyDir,filename(raw))),{code:'ENOENT'});
    assert.equal(await readFile(path.join(historyDir,filename(bad)),'utf8'),line(bad)+'torn');
    assert.equal(local.status().capacity?.pendingBytes,4);
    assert.equal(local.status().capacity?.acknowledgedFileBytes,0);
  } finally { await local.close(); }
});

test('routine sync caps acknowledged duplicates below the outage budget and continues writing after retirement', async t => {
  const dir = await directory(t), db = database(), cap = 800;
  const before = process.env.NOX_JOURNAL_ACK_CACHE_BYTES;
  process.env.NOX_JOURNAL_ACK_CACHE_BYTES = String(cap);
  t.after(() => { if (before === undefined) delete process.env.NOX_JOURNAL_ACK_CACHE_BYTES; else process.env.NOX_JOURNAL_ACK_CACHE_BYTES = before; });
  let store = new HistoryStore(dir,undefined,db.pool);
  try {
    await store.init();
    for (let i = 0; i < 16; i++) {
      await store.append(event(String(i)));
      await store.sync();
      assert.ok(store.status().retention.journalBytes <= cap);
    }
    assert.equal(db.rows.size,16);
    assert.equal(store.status().retention.refusedRows,0);
    assert.ok(store.status().retention.retiredBytes > cap);
    assert.equal(store.status().retention.ackCacheBytes,cap);
    const measured = await store.measure();
    assert.equal(measured.acknowledgedFileBytes,measured.journalBytes);
    assert.ok(measured.journalBytes > 0, 'recent fallback history survives ordinary cache reclamation');
    await store.close();
    store = new HistoryStore(dir,undefined,db.pool);
    await store.init();
    assert.equal((await store.measure()).pendingBytes,0);
    assert.equal(db.state.inserts,16);
    assert.equal((await store.read('p','trade')).length,16);
  } finally { await store.close(); }
  // Local-only installations retain their primary data under the original history budget.
  const local = new HistoryStore(await directory(t));
  await local.init();
  try {
    for (let i = 0; i < 16; i++) await local.append(event(String(i)));
    assert.ok(local.status().retention.journalBytes > cap);
    assert.equal(local.status().retention.retiredBytes,0);
    assert.equal(local.status().retention.ackCacheBytes,null);
    assert.equal((await local.measure()).acknowledgedFileBytes,null);
    assert.equal((await local.read('p','trade')).length,16);
  } finally { await local.close(); }
});

for (const offset of [Number.MAX_SAFE_INTEGER, 2]) test(`invalid checkpoint ${offset} replays the partition and a SQL error isolates its exact row`, async t => {
  const dir = await directory(t), db = database(), first = new HistoryStore(dir,undefined,db.pool);
  const a = event('first','l2'), bad = event('blocked','l2'), tail = event('later','l2'), healthy = event('healthy');
  await first.init();
  await first.append(a);
  await first.close();
  const cp = path.join(dir,(await readdir(dir)).find(f=>f.startsWith('history-checkpoints'))!);
  const saved = JSON.parse(await readFile(cp,'utf8'));
  saved.files['history/'+filename(a)].offset = offset;
  await writeFile(cp,JSON.stringify(saved));
  await appendFile(path.join(dir,'history',filename(a)),line(bad)+line(tail));
  await writeFile(path.join(dir,'history',filename(healthy)),line(healthy));
  db.rows.clear();
  db.state.reject = bad.id;
  const store = new HistoryStore(dir,undefined,db.pool);
  try {
    await store.init();
    assert.deepEqual([...db.rows.keys()].sort(),['first','healthy']);
    assert.match(store.status().error!,new RegExp('byte '+Buffer.byteLength(line(a))+' .*22P02'));
    assert.doesNotMatch(store.status().error!,/private rejected payload/);
    assert.equal((await store.measure()).pendingBytes,Buffer.byteLength(line(bad)+line(tail)));
    const hybrid = await store.page('p',{kind:'l2'});
    assert.deepEqual(hybrid.items.map(e=>e.id).sort(),['blocked','first','later']);
    db.state.reject = '';
    await store.sync();
    assert.equal((await store.measure()).pendingBytes,0);
    assert.equal(store.status().error,null);
    assert.deepEqual([...db.rows.keys()].sort(),['blocked','first','healthy','later']);
  } finally { await store.close(); }
});

test('a hybrid reader sees a pending row committed and retired after its database snapshot',async t => {
  const dir = await directory(t), db = database(), pending = event('pending','trade',yesterday);
  const local = new HistoryStore(dir);
  await local.init();
  await local.append(pending);
  await local.close();
  const previous = process.env.NOX_JOURNAL_MAX_BYTES;
  process.env.NOX_JOURNAL_MAX_BYTES = '1';
  t.after(() => { if (previous === undefined) delete process.env.NOX_JOURNAL_MAX_BYTES; else process.env.NOX_JOURNAL_MAX_BYTES = previous; });
  db.state.reject = pending.id;
  const store = new HistoryStore(dir,undefined,db.pool);
  const selected = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), committed = Promise.withResolvers<void>();
  try {
    await store.init();
    db.state.afterSelect = async () => { selected.resolve(); await resume.promise; };
    const page = store.page('p',{kind:'trade'});
    await selected.promise;
    db.state.reject = '';
    db.state.afterCommit = committed.resolve;
    const sync = store.sync();
    await committed.promise;
    resume.resolve();
    assert.deepEqual((await page).items.map(e => e.id),['pending']);
    await sync;
    assert.deepEqual(await readdir(path.join(dir,'history')),[]);
  } finally { resume.resolve(); await store.close(); }
});

test('an over-budget legacy file keeps its pending suffix through prefix reclamation and restart', async t => {
  const dir = await directory(t), db = database(), oldLimit = process.env.NOX_JOURNAL_MAX_BYTES;
  process.env.NOX_JOURNAL_MAX_BYTES = '4096';
  t.after(() => {
    if (oldLimit === undefined) delete process.env.NOX_JOURNAL_MAX_BYTES;
    else process.env.NOX_JOURNAL_MAX_BYTES = oldLimit;
  });
  const confirmed = { ...event('confirmed-prefix'), payload: { data: 'x'.repeat(12_000) } };
  const pending = event('blocked-tail'), after = event('after-tail');
  const suffix = line(pending) + line(after);
  const original = line(confirmed) + suffix, legacy = path.join(dir, 'history-trade.ndjson');
  await writeFile(legacy, original);
  db.state.online = false;
  db.state.reject = pending.id;
  const first = new HistoryStore(dir, undefined, db.pool);
  try {
    await first.init();
    assert.equal(await readFile(legacy, 'utf8'), original);
    db.state.online = true;
    await first.sync();
    assert.deepEqual([...db.rows.keys()], [confirmed.id]);
    assert.equal(await readFile(legacy, 'utf8'), suffix);
    const measurement = await first.measure();
    assert.equal(measurement.pendingBytes, Buffer.byteLength(suffix));
    assert.equal(measurement.journalBytes, measurement.pendingBytes);
    const live = event('fresh', 'snapshot');
    await first.append(live);
    await first.sync();
    assert.ok(db.rows.has(live.id));
  } finally { await first.close(); }
  db.state.reject = '';
  const restarted = new HistoryStore(dir, undefined, db.pool);
  try {
    await restarted.init();
    assert.equal((await restarted.measure()).pendingBytes, 0);
    assert.deepEqual([...db.rows.keys()].sort(), [after.id, pending.id, confirmed.id, 'fresh'].sort());
  } finally { await restarted.close(); }
});

test('history and sampling reads see the local tail without triggering replication', async t => {
  const dir = await directory(t), db = database(), store = new HistoryStore(dir, undefined, db.pool);
  await store.init();
  try {
    const boundary = Math.floor(now / 300_000) * 300_000;
    await store.append(event('recent', 'snapshot', boundary));
    const queryCount = db.state.queries.length;
    for (let i = 0; i < 10; i++) {
      const page = await store.page('p', {kind:'snapshot'});
      assert.deepEqual(page.items.map(row => row.id), ['recent']);
      assert.deepEqual((await store.sampleSnapshots('p', 300_000, boundary + 90_000)).map(row => row.id), ['recent']);
    }
    assert.equal((await store.page('p', {kind:'trade'})).localScan, false);
    const queries = db.state.queries.slice(queryCount);
    assert.equal(queries.length, 21);
    assert.ok(queries.every(sql => sql.includes('FROM nox_history_events')));
    assert.equal(store.status().writes.databaseInsertBatches, 0);
    await store.sync();
    const persisted = await store.page('p', {kind:'snapshot'});
    assert.deepEqual(persisted.items.map(row => row.id), ['recent']);
    assert.equal(persisted.localScan, false);
  } finally { await store.close(); }
});

test('publish each membership edit before reads, then only write to repair a missing interval', async t => {
  const dir = await directory(t), db = database(), store = new HistoryStore(dir, undefined, db.pool);
  const project = {id:'p',archived:false,markets:[{exchange:'okx',marketType:'spot',symbol:'BTCUSDT'}]} as MarketProject;
  const started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  await store.init();
  try {
    db.state.beforeLinkWrite = async () => { started.resolve(); await resume.promise; };
    const edit = store.reconcileProjects([project]);
    const read = store.page('p', {kind:'trade'});
    await started.promise;
    assert.ok(!db.state.queries.some(sql => sql.includes('FROM nox_history_events e WHERE')));
    resume.resolve();
    await Promise.all([edit,read]);
    const writes = () => db.state.queries.filter(sql => sql.startsWith('INSERT INTO nox_project_market_links')).length;
    assert.equal(writes(), 1);
    await store.reconcileProjects([project]);
    for (let i = 0; i < 3; i++) await store.sync();
    assert.equal(writes(), 1);
    db.state.missingLink = true; // Restore retained the database UUID but lost a historical interval.
    await store.sync();
    assert.equal(writes(), 2);
  } finally { resume.resolve(); await store.close(); }
});

test('one checkpoint publishes four committed insert batches, with conflicts excluded from row counts', async t => {
  const dir = await directory(t), db = database(), store = new HistoryStore(dir, undefined, db.pool);
  await store.init();
  try {
    const before = store.status().writes;
    await Promise.all(Array.from({length:1000}, (_,i) => store.append(event(String(i % 999)))));
    await store.sync();
    const writes = store.status().writes;
    assert.equal(writes.checkpointReplacements - before.checkpointReplacements, 1);
    assert.equal(writes.databaseInsertBatches, 4);
    assert.equal(writes.databaseRowsInserted, 999);
    assert.equal(writes.journalRowsByKind.trade, 1000);
    assert.equal(writes.journalBatches, 8);
    await store.sync();
    assert.deepEqual(store.status().writes, writes);
    assert.equal((await store.measure()).pendingBytes, 0);
  } finally { await store.close(); }
});

test('failed checkpoint publication retains the source and retries committed events idempotently', async t => {
  const dir = await directory(t), db = database(), store = new HistoryStore(dir, undefined, db.pool);
  await store.init();
  try {
    const name = (await readdir(dir)).find(file => file.startsWith('history-checkpoints-'))!;
    const checkpoint = path.join(dir, name), original = await readFile(checkpoint, 'utf8');
    await mkdir(checkpoint + '.tmp');
    await store.append(event('committed'));
    await store.sync();
    assert.equal(store.status().connected, false);
    assert.equal(store.status().writes.databaseRowsInserted, 1);
    assert.equal(await readFile(checkpoint, 'utf8'), original);
    assert.ok((await store.measure()).pendingBytes > 0);
    assert.deepEqual((await store.read('p','trade')).map(row => row.id), ['committed']);
    await rm(checkpoint + '.tmp', {recursive:true});
    await store.sync();
    assert.equal(store.status().connected, true);
    assert.equal((await store.measure()).pendingBytes, 0);
    assert.equal(store.status().writes.databaseInsertBatches, 2);
    assert.equal(store.status().writes.databaseRowsInserted, 1);
    assert.notEqual(await readFile(checkpoint, 'utf8'), original);
  } finally { await store.close(); }
});
