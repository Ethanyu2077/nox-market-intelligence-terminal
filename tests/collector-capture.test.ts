import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { MarketProject, ProjectVenueResponse, VenueMarketSnapshot } from '../shared/types.ts';
import type { TimeframeAlignmentResponse } from '../shared/timeframe.ts';
import { ProjectCollector } from '../server/collector.ts';
import { HistoryStore } from '../server/history-store.ts';
import type { OrderFlowService } from '../server/orderflow-service.ts';

const start = Date.UTC(2026, 0, 1);
const project: MarketProject = {
  id: 'p', name: 'Test', tokenSymbol:'ABC', contractAddress: null, identitySource:'symbol', identityNetwork:null,
  markets:[{id:'m', exchange:'binance',symbol:'ABCUSDT',marketType:'perpetual',base:'ABC',quote:'USDT',status:'TRADING'}],
  primaryMarketId:'m', monitoring:{collectionMode:'active', defaultInterval:'5m', streamingEnabled:true},
  archived:false,order:0,createdAt:start,updatedAt:start,
};
function quote(time: number): VenueMarketSnapshot {
  return { exchange:'binance',symbol:'ABCUSDT',marketType:'perpetual',price:1,markPrice:null,change24hPct:null,
    volume24hBase:null,volume24hUsd:null,takerBuyVolumeUsd:null,takerSellVolumeUsd:null,volumeDeltaUsd:null,cvd:null,
    oiBase:1,oiUsd:1,oiDeltaBase:null,oiDeltaUsd:null,fundingRate:null,nextFundingTime:null,bid:null,ask:null,spreadBps:null,
    eventTime:time,fetchedAt:time,quality:'live',source:'fixture',unavailable:['bid','ask'] };
}
async function setup(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(),'nox-capture-'));
  const history = new HistoryStore(dir);
  await history.init();
  t.after(async () => { await history.close(); await rm(dir,{recursive:true,force:true}); });
  const state = {time:start, polls:0, volumes:0, alignments:0, quote:quote(start)};
  t.mock.method(Date, 'now', () => state.time);
  const flow = {acquire: () => () => {}} as unknown as OrderFlowService;
  const worker = (mode: 'active' | 'standard' = 'active') => new ProjectCollector(
    () => [{...project, monitoring:{...project.monitoring, collectionMode:mode}}],
    flow, history, async () => {
      state.polls++;
      return {snapshots:[{...state.quote,fetchedAt:state.time}],failures:[]} as unknown as ProjectVenueResponse;
    }, undefined, undefined, async () => { state.volumes++; return {legs:[],failures:[]}; },
    async () => { state.alignments++; return {generatedAt:state.time} as TimeframeAlignmentResponse; },
  );
  return {state,history,worker,dir};
}

test('active polls every 30s while archiving one quote and decision per minute and one turnover row per five minutes', async t => {
  const {state,history,worker} = await setup(t);
  let collector = worker();
  for (let i=0;i<20;i++) {
    state.time = start + i*30_000;
    state.quote = quote(state.time);
    if (i===3) { await collector.close(); collector=worker(); }
    await collector.tick();
  }
  assert.equal(state.polls,20);
  assert.equal(state.volumes,2);
  assert.equal(state.alignments,10);
  for (const [kind,expected] of [['snapshot',10],['volume',2],['alignment',10]] as const) {
    const events = await history.read('p',kind,state.time);
    assert.equal(events.length,expected);
    assert.equal(new Set(events.map(e => Math.floor(e.ingestTime / (kind==='volume' ? 300_000 : 60_000)))).size,expected);
  }
  await collector.close();
});

test('repeated source quotes stay suppressed through restart; same-time evidence revisions and quality changes survive', async t => {
  const {state,history,worker}=await setup(t);
  let collector=worker();
  await collector.tick();
  await collector.close();
  state.time+=60_000;
  state.quote.unavailable.reverse();
  collector=worker();
  await collector.tick();
  assert.equal((await history.read('p','snapshot',state.time)).length,1);
  state.time+=30_000; state.quote.price=2;
  await collector.tick();
  state.time+=30_000; state.quote=quote(state.time); await collector.tick();
  state.time+=30_000; state.quote={...quote(state.time),quality:'stale'}; await collector.tick();
  const rows=await history.read('p','snapshot',state.time);
  assert.equal(rows.length,4);
  assert.deepEqual(rows.map(e => e.eventTime),[start,start,start+120_000,start+150_000]);
  assert.deepEqual(rows.map(e => (e.payload as VenueMarketSnapshot).price), [1,2,1,1]);
  assert.equal(rows.at(-1)?.quality,'stale');
  await collector.close();
});

test('failed volume and snapshot appends remain eligible on the next poll', async t => {
  const {state,history,worker}=await setup(t);
  const append=history.append.bind(history);
  const failOnce = new Set(['snapshot','volume']);
  t.mock.method(history,'append',(event: Parameters<HistoryStore['append']>[0]) => {
    if (failOnce.delete(event.kind)) return Promise.reject(new Error('transient write failure'));
    return append(event);
  });
  const collector=worker();
  for(let i=0;i<3;i++){state.time=start+i*30_000; await collector.tick();}
  assert.deepEqual((await history.read('p','snapshot',state.time)).map(e => e.ingestTime),[start+30_000]);
  assert.deepEqual((await history.read('p','volume',state.time)).map(e => e.ingestTime),[start+60_000]);
  assert.equal(state.volumes,2);
  await collector.close();
});

test('restart rejects an out-of-order quote after restoring a newer source timestamp', async t => {
  const {state,history,worker}=await setup(t);
  let collector=worker();
  await collector.tick();
  await collector.close();
  collector=worker();
  state.time+=30_000; state.quote={...quote(start-2_000),price:99};
  await collector.tick();
  state.time+=30_000; state.quote=quote(state.time);
  await collector.tick();
  assert.deepEqual((await history.read('p','snapshot',state.time)).map(e => e.eventTime),[start,start+60_000]);
  await collector.close();
});

test('restart reads a bounded ingest-day tail, retains stale-source corrections, and skips an unconfirmed old quote', async t => {
  const {state,history,worker,dir}=await setup(t);
  const staleTime=start-3*86_400_000;
  state.quote=quote(staleTime);
  const stored={id:'earlier',kind:'snapshot',marketKey:'binance:perpetual:ABCUSDT',projectId:'p',
    source:'fixture',quality:'live',eventTime:staleTime,ingestTime:start-1,payload:state.quote};
  const recent=path.join(dir,'history','2025-12-31-snapshot.ndjson');
  await writeFile(recent,'x'.repeat(700_000)+'\n'+JSON.stringify(stored)+'\n');
  await writeFile(path.join(dir,'history','2025-12-01-snapshot.ndjson'),'unreadable prior ingest day\n');
  let collector=worker();
  state.quote.price=2; // The first cold-start quote already corrects the persisted one.
  await collector.tick();
  assert.equal(history.status().writes.journalRowsByKind.snapshot,1);
  state.time+=30_000;
  await collector.tick();
  assert.equal(history.status().writes.journalRowsByKind.snapshot,1);
  await collector.close();

  // No matching row remains in the available suffix for this old source timestamp.
  await writeFile(recent,'x'.repeat(700_000)+'\n'+JSON.stringify({...stored,projectId:'other'})+'\n');
  await writeFile(path.join(dir,'history','2026-01-01-snapshot.ndjson'),'');
  collector=worker();
  state.time+=30_000;
  await collector.tick();
  assert.equal(history.status().writes.journalRowsByKind.snapshot,1);
  state.time+=30_000; state.quote.fundingRate=0.01;
  await collector.tick();
  assert.equal(history.status().writes.journalRowsByKind.snapshot,2);
  await collector.close();
});

test('standard retains its five-minute collection and history cadence', async t => {
  const {state,history,worker}=await setup(t);
  const collector=worker('standard');
  for (let i=0;i<20;i++){ state.time=start+i*30_000; state.quote=quote(state.time); await collector.tick(); }
  assert.deepEqual([state.polls,state.volumes,state.alignments],[2,2,2]);
  assert.equal((await history.read('p','snapshot',state.time)).length,2);
  await collector.close();
});
