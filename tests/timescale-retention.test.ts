import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { HistoryStore, type HistoryEvent } from '../server/history-store.ts';
import { TimescaleRetention, TimescaleWritesPaused } from '../server/timescale-retention.ts';

const day = 86_400_000;
function fixture(clock: number, base: number, initial: Array<[number, number]>) {
  const state = { base, chunks: initial.map(([end, bytes]) => ({ end: new Date(end), bytes })), floor: null as Date | null,
    fail: false, inspected: 0, inserts: [] as string[], dbEvents: [] as HistoryEvent[] };
  const bytes = () => state.base + state.chunks.reduce((n, c) => n + c.bytes, 0);
  let cutoff: Date | null = null;
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql.includes('show_chunks(')) {
      state.inspected++;
      return { rows: [{ bytes: bytes(), clock: new Date(clock), floor: state.floor, expired: state.chunks.some(c=>c.end.getTime() <= clock - Number(args[0])*day) }] };
    }
    if (sql.includes('FROM chunks_detailed_size')) return { rows: state.chunks.filter(c => c.end.getTime()<=clock) };
    if (sql.includes('SELECT drop_chunks')) { cutoff = args[0] as Date; return { rows: [] }; }
    if (sql.startsWith('UPDATE nox_history_storage_meta') && state.fail) throw new Error('denied');
    if (sql === 'COMMIT' && cutoff) {
      state.floor = cutoff;
      state.chunks = state.chunks.filter(c=>c.end.getTime() > cutoff!.getTime());
      cutoff = null;
    }
    if (sql === 'ROLLBACK') cutoff = null;
    if (sql.startsWith('SELECT hypertable_size')) return {rows: [{bytes: bytes()}]};
    if (sql.startsWith('SELECT store_id')) return {rows: [{store_id:'test'}]};
    if (sql.includes('FROM pg_extension')) return {rowCount:1};
    if (sql.startsWith('INSERT INTO nox_history_events')) state.inserts.push(args[0] as string);
    if (sql.includes('FROM nox_history_events e WHERE') || sql.startsWith('SELECT DISTINCT ON (market_key')) return { rows: state.dbEvents };
    return {rows: []};
  };
  const client = {query, release() {}} as unknown as PoolClient;
  const pool = {on(){}, query, connect: async () => client, end() {}} as unknown as Pool;
  return {state, client, pool};
}
const now = Date.now();
test('reclaim oldest closed chunks by size and persist the replay floor; migration only admits data', async () => {
  const retention = new TimescaleRetention(), cap = retention.maxBytes;
  const db = fixture(now, Math.floor(cap * .1), [[now-day*8, Math.floor(cap*.2)], [now-day, Math.floor(cap*.15)], [now+day, Math.floor(cap*.5)]]);
  const importer = new TimescaleRetention();
  await assert.rejects(importer.check(db.client,'a',false), TimescaleWritesPaused);
  assert.equal(db.state.floor,null);
  await retention.check(db.client,'a');
  assert.equal(Number(db.state.floor),now-day*8);
  assert.equal(db.state.chunks.length,2);
  assert.equal(retention.expired(now-day*8-1),true);
  assert.equal(retention.expired(now-day*8),false);
  const restarted = new TimescaleRetention();
  await restarted.check(db.client,'a');
  assert.equal(restarted.expired(now-day*8-1),true);
  assert.equal(restarted.expired(now-day*8),false);
  await restarted.check(db.client,'a');
  assert.equal(db.state.inspected,3);
});
test('expire whole old chunks when under budget; failed floor write rolls back the drop', async () => {
  const db = fixture(now,100,[[now-day*200,10],[now,10]]);
  db.state.fail=true;
  await assert.rejects(new TimescaleRetention().check(db.client,'a'),TimescaleWritesPaused);
  assert.equal(db.state.chunks.length,2);
  assert.equal(db.state.floor,null);
  db.state.fail=false;
  const retention=new TimescaleRetention();
  await retention.check(db.client,'a');
  assert.equal(db.state.chunks.length,1);
  assert.equal(retention.expired(now-100*day),true);
});
test('pressure holds new events locally, merges them with durable DB history, and resumes after recovery', async t => {
  const cap = new TimescaleRetention().maxBytes;
  const db = fixture(now,cap,[]);
  const dir = await mkdtemp(path.join(tmpdir(),'nox-hot-chunk-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const time = Math.floor((now-300_000)/300_000)*300_000;
  const event = (id: string, when: number): HistoryEvent => ({id,kind:'snapshot',source:'test',marketKey:'x',projectId:'p',eventTime:when,ingestTime:now,quality:'live',payload:{price:2}});
  db.state.dbEvents=[event('database',time-300_000)];
  const store = new HistoryStore(dir,undefined,db.pool);
  await store.init();
  await store.append(event('pending',time));
  const page = await store.page('p',{kind:'snapshot',asOf:now});
  assert.deepEqual(page.items.map(e=>e.id),['pending','database']);
  assert.equal(page.backend,'timescaledb');
  assert.equal(page.localScan,true);
  assert.match(page.fallback!,/budget/);
  assert.deepEqual((await store.sampleSnapshots('p',300_000,now)).map(e=>e.id),['database','pending']);
  assert.deepEqual(db.state.inserts,[]);
  await store.close();
  db.state.base = 0;
  const recovered = new HistoryStore(dir,undefined,db.pool);
  await recovered.init();
  assert.deepEqual(db.state.inserts,['pending']);
  assert.equal((await recovered.measure()).pendingBytes,0);
  await recovered.append({...event('expired',now-200*day),ingestTime:now});
  await recovered.sync();
  assert.deepEqual(db.state.inserts,['pending']);
  assert.equal((await recovered.measure()).pendingBytes,0);
  await recovered.close();
});
