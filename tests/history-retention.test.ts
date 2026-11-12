import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {HistoryStore, type HistoryEvent} from '../server/history-store.ts';
import {JournalReaders} from '../server/history-retention.ts';

const DAY = 86_400_000;
function fixture(id: string, at: number): HistoryEvent {
  return {id, kind:'trade', marketKey:'market', projectId:'p', eventTime:at, ingestTime:at,
    source:'test', quality:'live', payload:{pad:'x'.repeat(100)}};
}
async function directory(t: TestContext, bytes: number, reserve = 1) {
  for (const [name, value] of Object.entries({
    NOX_JOURNAL_MAX_BYTES: bytes, NOX_JOURNAL_RETENTION_DAYS: 45, NOX_STORAGE_MIN_FREE_BYTES: reserve,
  })) {
    const original = process.env[name];
    process.env[name] = String(value);
    t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'nox-journal-quota-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  await mkdir(path.join(dir, 'history'));
  return dir;
}
async function seed(dir: string, row: HistoryEvent) {
  const file = path.join(dir, 'history', new Date(row.ingestTime).toISOString().slice(0,10) + '-trade.ndjson');
  await writeFile(file, JSON.stringify(row) + '\n');
  await utimes(file, new Date(row.ingestTime), new Date(row.ingestTime));
}
test('startup expires old local partitions while retaining recent history and unrelated files', async t => {
  const dir = await directory(t, 1024 * 1024), now = Date.now();
  await seed(dir, fixture('expired', now - 50 * DAY));
  await seed(dir, fixture('recent', now - DAY));
  await writeFile(path.join(dir, 'history', 'operator.txt'), 'retained');
  const local = new HistoryStore(dir);
  await local.init();
  try {
    assert.deepEqual((await local.read('p','trade')).map(e => e.id), ['recent']);
    assert.equal(await readFile(path.join(dir,'history','operator.txt'), 'utf8'), 'retained');
    assert.ok(local.status().retention.retiredBytes > 0);
  } finally { await local.close(); }
});

test('same-day rolling history stays within budget and preserves newest rows across restart', async t => {
  const dir = await directory(t, 2200), start = Date.now() - 5000;
  let local = new HistoryStore(dir);
  await local.init();
  try {
    for (let i = 0; i < 32; i++) {
      await local.append(fixture(String(i).padStart(2,'0'), start+i));
      assert.ok(local.status().retention.journalBytes <= 2200);
    }
    const expected = (await local.read('p','trade')).map(e=>e.id);
    assert.ok(expected.length >= 2 && expected.length < 32);
    assert.equal(expected.at(-1), '31');
    assert.equal(local.status().retention.refusedRows, 0);
    await local.close();
    local = new HistoryStore(dir);
    await local.init();
    assert.deepEqual((await local.read('p','trade')).map(e=>e.id), expected);
  } finally { await local.close(); }
});

test('an offline configured DB protects pending data at quota and reclaims once acknowledged', async t => {
  const latest = Date.now(), old = fixture('pending', latest-DAY), next = fixture('next', latest);
  const bytes = Buffer.byteLength(JSON.stringify(old)+'\n') + 5;
  const dir = await directory(t, bytes);
  await seed(dir,old);
  let online = false;
  const inserted: string[] = [];
  async function query(sql: string, args: unknown[] = []) {
    if (sql.startsWith('SELECT 1 FROM pg_extension')) return {rowCount:1};
    if (sql.startsWith('SELECT store_id')) return {rows:[{store_id:'test-database'}]};
    if (sql.startsWith('SELECT hypertable_size')) return {rows:[{bytes:'0', clock:new Date(), expired:false, floor:null}]};
    if (sql.startsWith('INSERT INTO nox_history_events')) inserted.push(String(args[0]));
    return {rowCount:0,rows:[]};
  }
  const pool = {on() {}, end() {}, connect:async () => {
    if (!online) throw new Error('offline');
    return {query,release() {}};
  }, query} as unknown as Pool;
  const store = new HistoryStore(dir,undefined,pool);
  await store.init();
  try {
    await assert.rejects(store.append(next), /limit|reserve/);
    assert.deepEqual((await store.read('p','trade')).map(e=>e.id), ['pending']);
    assert.equal(store.status().retention.refusedRows,1);
    online = true;
    await store.sync();
    assert.deepEqual(inserted,['pending']);
    await store.append(next);
    await store.sync();
    assert.deepEqual(inserted,['pending','next']);
    assert.equal(store.status().retention.warning,null);
    const checkpointFile = (await readdir(dir)).find(name=>name.startsWith('history-checkpoints-'))!;
    assert.equal(Object.keys(JSON.parse(await readFile(path.join(dir,checkpointFile),'utf8')).files).length,1);
  } finally { await store.close(); }
});

test('reserve refuses new history when the filesystem is already below its configured minimum', async t => {
  const dir = await directory(t, 4096, Number.MAX_SAFE_INTEGER);
  const store = new HistoryStore(dir);
  await store.init();
  try {
    await assert.rejects(store.append(fixture('x',Date.now())), /reserve/);
    assert.equal(store.status().retention.queuedBytes,0);
    assert.equal((await store.read('p','trade')).length,0);
    assert.deepEqual(await readdir(path.join(dir,'history')),[]);
  } finally { await store.close(); }
});

test('retention waits for active readers and new readers see the completed sweep', async () => {
  const readers = new JournalReaders(), log: string[] = [];
  let done!: () => void;
  const first = readers.read(async () => {
    await new Promise<void>(r=>{done=r;});
    log.push('read');
  });
  const sweep = readers.exclusive(async () => {log.push('sweep');});
  const second = readers.read(async () => {log.push('next');});
  done();
  await Promise.all([first,sweep,second]);
  assert.deepEqual(log,['read','sweep','next']);
});
