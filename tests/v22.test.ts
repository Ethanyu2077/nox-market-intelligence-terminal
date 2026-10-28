import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { AuthStore, canWrite } from '../server/auth.ts';
import { HistoryStore, type HistoryEvent } from '../server/history-store.ts';
import { FileStore } from '../server/store.ts';
import { collectionMode, ProjectCollector } from '../server/collector.ts';
import { OrderFlowService } from '../server/orderflow-service.ts';
import type { ProjectVenueResponse } from '../shared/types.ts';
import { evaluateRegime, signalLab, type RegimeSignal } from '../server/regime.ts';
import type { MarketProject, VenueMarketSnapshot } from '../shared/types.ts';
import type { OrderFlowResponse } from '../shared/orderflow.ts';

const now = 1_800_000_000_000;
const project: MarketProject = { id: 'p', name: 'Selected project', tokenSymbol: 'TEST', contractAddress: null, identitySource: 'symbol', identityNetwork: null, markets: [{ id: 'm', exchange: 'binance', marketType: 'perpetual', symbol: 'TESTUSDT', base: 'TEST', quote: 'USDT', status: 'TRADING' }], primaryMarketId: 'm', monitoring: { defaultInterval: '5m', streamingEnabled: true }, archived: false, order: 0, createdAt: now, updatedAt: now };
function snapshot(time: number, price: number, oi: number, ingest = time): HistoryEvent {
  return { id: `s${time}`, kind: 'snapshot', marketKey: 'binance:perpetual:TESTUSDT', projectId: 'p', eventTime: time, ingestTime: ingest, source: 'fixture', quality: 'live', payload: { exchange: 'binance', marketType: 'perpetual', symbol: 'TESTUSDT', price, oiBase: oi, fundingRate: null } as VenueMarketSnapshot };
}
const flow = { venues: [{ key: 'binance:perpetual:TESTUSDT', buckets: [{ time: now-300_000, complete: true, delta: 20 }] }], aggregates: { spot: { buckets: [] } } } as unknown as OrderFlowResponse;

test('monitoring modes migrate safely and archived/disabled always pause', () => {
  assert.equal(collectionMode(project), 'standard');
  assert.equal(collectionMode({ ...project, monitoring: { ...project.monitoring, collectionMode: 'active' } }), 'active');
  assert.equal(collectionMode({ ...project, archived: true }), 'paused');
  assert.equal(collectionMode({ ...project, monitoring: { ...project.monitoring, collectionMode: 'active', streamingEnabled: false } }), 'paused');
});
test('background Active ownership survives without browsers and Paused releases it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'nox-collector-'));
  const history = new HistoryStore(directory); await history.init();
  let acquired = 0, released = 0;
  const flowService = { acquire: () => { acquired++; return () => { released++; }; }, snapshot: () => flow } as unknown as OrderFlowService;
  const selected = structuredClone(project); selected.monitoring.collectionMode = 'active';
  const worker = new ProjectCollector(() => [selected],flowService,history,async () => ({ snapshots:[],failures:[] } as unknown as ProjectVenueResponse));
  await worker.tick(); await worker.tick(); assert.equal(acquired,1); assert.equal(released,0);
  selected.monitoring.collectionMode = 'paused'; await worker.tick(); assert.equal(released,1);
  assert.equal(worker.status()[0].mode,'paused'); await worker.close(); await history.close();
});
test('configured but unavailable database is degraded and retains retry history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'nox-db-retry-'));
  const history = new HistoryStore(directory,'postgresql://nox:fixture@127.0.0.1:1/nox'); await history.init();
  await history.append(snapshot(now,100,100)); await history.sync();
  assert.equal(history.status().connected,false); assert.match(history.status().error!,/retained/);
  assert.equal((await history.read('p','snapshot',now)).length,1); await history.close();
});
test('history survives restart and rejects late-ingested records at historical cutoff', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-history-'));
  const history = new HistoryStore(directory); await history.init();
  await history.append(snapshot(now,100,100,now+10)); await history.close();
  const restarted = new HistoryStore(directory); await restarted.init();
  assert.equal((await restarted.read('p','snapshot',now)).length,0);
  assert.equal((await restarted.read('p','snapshot',now+10)).length,1);
  assert.equal(restarted.status().connected,false); await restarted.close();
});
test('project preferences persist modes, duplicate reorders fail and corrupt files are preserved', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-project-'));
  const store = new FileStore(directory); await store.init();
  const a = await store.addProject(project), b = await store.addProject(project);
  await store.updateProject(a.id, { monitoring: { collectionMode: 'active' } });
  const restored = new FileStore(directory); await restored.init();
  assert.equal(restored.getProjects()[0].monitoring.collectionMode,'active');
  await assert.rejects(restored.reorderProjects([b.id,b.id]));
  await writeFile(path.join(directory,'preferences.json'),'{broken');
  await assert.rejects(new FileStore(directory).init());
  assert.equal(await readFile(path.join(directory,'preferences.json'),'utf8'),'{broken');
});
test('regime uses base OI and real same-venue closed-bucket delta, not USD price revaluation', () => {
  const signal = evaluateRegime('p',[snapshot(now-300_000,100,100),snapshot(now,101,101)],flow,now+1000);
  assert.equal(signal.label,'Potential long build-up'); assert.equal(signal.classification,'statistical-inference');
  const flat = evaluateRegime('p',[snapshot(now-300_000,100,100),snapshot(now,101,100)],flow,now+1000);
  assert.notEqual(flat.label,'Potential long build-up');
});
test('missing or incomplete flow cannot produce confident position inference', () => {
  const incomplete = structuredClone(flow); incomplete.venues[0].buckets[0].complete = false;
  const result = evaluateRegime('p',[snapshot(now-300_000,100,100),snapshot(now,101,101)],incomplete,now+1000);
  assert.equal(result.heuristicConfidence,null); assert.equal(result.metrics.deltaUsd,null);
});
test('regime excludes future snapshots and future-ingested history', () => {
  const result = evaluateRegime('p',[snapshot(now-300_000,100,100),snapshot(now,101,101,now+20_000),snapshot(now+300_000,200,200)],flow,now+1000);
  assert.equal(result.label,'Insufficient evidence');
});
test('signal lab matures horizons, costs and sampled excursions without lookahead', () => {
  const signal = { id: 'r', timestamp: now, venue: 'binance:perpetual:TESTUSDT', label: 'Potential long build-up', referencePrice: 100 } as RegimeSignal;
  const event: HistoryEvent = { id:'r',kind:'regime',marketKey:'project',projectId:'p',eventTime:now,ingestTime:now,source:'fixture',quality:'partial',payload:signal };
  const snapshots = [snapshot(now+60_000,102,100),snapshot(now+120_000,99,100),snapshot(now+300_000,101,100)];
  assert.equal(signalLab([event],snapshots,5,10,now+120_000).coverage.evaluated,0);
  const result = signalLab([event],snapshots,5,10,now+300_000).rows[0];
  assert.equal(result.complete,true); assert.ok(Math.abs(result.researchDirectionalReturnAfterCostsPct! - 0.9)<1e-9);
  assert.ok(Math.abs(result.sampledMfePct! - 2)<1e-9); assert.ok(Math.abs(result.sampledMaePct! + 1)<1e-9);
  const late = snapshots.map(e => ({...e,ingestTime:now+900_000}));
  assert.equal(signalLab([event],late,5,10,now+300_000).rows[0].complete,false);
});
test('RBAC does not allow viewer mutation or analyst deletion', () => {
  assert.equal(canWrite('viewer','analyst'),false); assert.equal(canWrite('analyst','admin'),false);
  assert.equal(canWrite('analyst','analyst'),true); assert.equal(canWrite('admin','admin'),true);
});
test('authentication bootstrap is local, hashed, session-bound and guards mutations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'nox-auth-'));
  const auth = new AuthStore(directory); await auth.init();
  const app = express(); app.use(express.json()); auth.install(app);
  app.post('/api/projects',(_req,res) => res.json({ok:true}));
  const server = app.listen(0,'127.0.0.1'); await new Promise<void>(resolve => server.once('listening',resolve));
  const port = (server.address() as {port:number}).port;
  const post = (route: string, body: unknown, cookie = '') => fetch(`http://127.0.0.1:${port}/api${route}`,{ method:'POST', headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(body) });
  try {
    assert.equal((await post('/projects',{})).status,401);
    const token = auth.setSetupToken();
    const setup = await post('/auth/setup',{ token,name:'tester',password:'test-password-only-123' });
    assert.equal(setup.status,200); const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    assert.match(setup.headers.get('set-cookie')! ,/HttpOnly/); assert.match(setup.headers.get('set-cookie')!,/SameSite=Strict/);
    assert.equal((await post('/projects',{},cookie)).status,200);
    assert.ok(!(await readFile(path.join(directory,'auth.sqlite'))).includes(Buffer.from('test-password-only-123')));
    await post('/auth/logout',{},cookie); assert.equal((await post('/projects',{},cookie)).status,401);
    assert.equal((await post('/auth/setup',{token,name:'attacker',password:'test-password-only-123'})).status,409);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); auth.close(); }
});
