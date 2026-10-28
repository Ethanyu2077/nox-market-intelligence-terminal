import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {scryptSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import {ProviderCredentials,installProviderSettings} from '../server/provider-credentials.ts';
import {AuthStore} from '../server/auth.ts';
import {CoinGlassClient,normalizeCoinGlassFlow,normalizeCoinGlassHistory,CoinGlassService} from '../server/coinglass.ts';
import type {MarketProject} from '../shared/types.ts';

test('provider credentials encrypt at rest, survive restart, and do not expose keys in status',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nox-providers-'));
  let store=new ProviderCredentials(dir);await store.init();store.set('coinglass','fixture-secret-key');
  assert.equal(store.get('coinglass'),'fixture-secret-key');assert.equal(store.status('coinglass').saved,true);
  assert.ok(!(await readFile(path.join(dir,'providers.sqlite'))).includes(Buffer.from('fixture-secret-key')));
  assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(path.join(dir,'provider-master.key'))).mode&0o777,0o600);assert.equal((await stat(path.join(dir,'providers.sqlite'))).mode&0o777,0o600);
  store.close();store=new ProviderCredentials(dir);await store.init();assert.equal(store.get('coinglass'),'fixture-secret-key');
  const db=new DatabaseSync(path.join(dir,'providers.sqlite'));db.prepare('UPDATE credentials SET provider=? WHERE provider=?').run('wrong-provider','coinglass');db.close();
  assert.throws(()=>store.get('wrong-provider'),/Cannot decrypt/);store.close();
});
test('only admins can read/save/test/delete provider keys; hot updates and sanitized verification work',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nox-provider-routes-')),auth=new AuthStore(dir),store=new ProviderCredentials(dir);await auth.init();await store.init();
  const db=new DatabaseSync(path.join(dir,'auth.sqlite'));const salt='a'.repeat(32),hash=scryptSync('fixture-password',salt,64).toString('hex');for(const role of ['admin','analyst','viewer'])db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(role,role,salt,hash);db.close();
  const app=express();app.use(express.json());auth.install(app);let current='';
  installProviderSettings(app,auth,store,key=>{current=key;},key=>new CoinGlassClient(key,async()=>new Response(JSON.stringify(key==='bad-key'?{code:'401',msg:'never expose fixture-secret'}:{code:'0',data:['TEST']}))),'environment-key');
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  const request=(method:string,route:string,cookie='',body:unknown={})=>fetch(base+route,{method,headers:{cookie,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});
  const route='/settings/providers/coinglass';
  try{
    assert.equal((await request('GET',route)).status,401);assert.equal((await request('PUT',route,'',{apiKey:'secret'})).status,401);
    let admin='';for(const role of ['admin','analyst','viewer']){const login=await request('POST','/auth/login','',{name:role,password:'fixture-password'}),cookie=login.headers.get('set-cookie')!.split(';')[0];if(role==='admin'){admin=cookie;continue;}for(const method of ['GET','PUT','DELETE'])assert.equal((await request(method,route,cookie,{apiKey:'secret'})).status,403);assert.equal((await request('POST',route+'/test',cookie)).status,403);}
    assert.equal((await request('PUT',route,admin,{apiKey:'invalid whitespace'})).status,400);
    const saved=await request('PUT',route,admin,{apiKey:'fixture-secret'}),body=await saved.text();assert.equal(saved.status,200);assert.ok(!body.includes('fixture-secret'));assert.equal(current,'fixture-secret');
    const tested=await request('POST',route+'/test',admin);assert.equal(tested.status,200);assert.equal((await tested.json()).supportedCoins,1);
    const status=await request('GET',route,admin);assert.equal(status.headers.get('cache-control'),'no-store');const state=await status.json();assert.equal(state.source,'saved');assert.equal(state.lastTest.state,'verified');assert.ok(!JSON.stringify(state).includes('fixture-secret'));
    await request('PUT',route,admin,{apiKey:'bad-key'});const denied=await request('POST',route+'/test',admin);assert.equal(denied.status,502);assert.equal((await denied.json()).error.message,'authentication-failed');
    const removed=await request('DELETE',route,admin);assert.equal((await removed.json()).source,'environment');assert.equal(current,'environment-key');assert.equal(store.status('coinglass').saved,false);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));auth.close();store.close();}
});
test('CoinGlass flow separates aggregate and venue values; rolling delta and malformed observations stay explicit',()=>{
  const flow=normalizeCoinGlassFlow({symbol:'TEST',buy_vol_usd:10,sell_vol_usd:4,buy_ratio:60,sell_ratio:40,exchange_list:[{exchange:'A',buy_vol_usd:0,sell_vol_usd:null}]},'TEST');
  assert.equal(flow[0].exchange,'All');assert.equal(flow[0].deltaUsd,6);assert.equal(flow[1].buyUsd,0);assert.equal(flow[1].deltaUsd,null);
  assert.throws(()=>normalizeCoinGlassFlow({symbol:'OTHER'},'TEST'),/invalid-response/);
  const now=Date.now(),rows=[{time:now-1000,open:'-0.01',high:'0.02',low:'-0.02',close:'0'},{time:now+1000,open:1,high:2,low:0,close:1}];
  assert.equal(normalizeCoinGlassHistory(rows,false,now).length,1);assert.equal(normalizeCoinGlassHistory(rows,true,now).length,0);
});
test('CoinGlass on-demand histories send explicit USD and intervals without mixing timestamps or source units',async()=>{
  const paths:string[]=[],now=Date.now();const client=new CoinGlassClient('key',async url=>{
    const u=new URL(String(url));paths.push(u.pathname);let data:unknown=[];
    if(u.pathname.endsWith('supported-coins'))data=['TEST'];
    else if(u.pathname.endsWith('/aggregated-history')||u.pathname.endsWith('/oi-weight-history')){assert.equal(u.searchParams.get('interval'),'4h');assert.equal(u.searchParams.get('limit'),'120');if(u.pathname.endsWith('/aggregated-history'))assert.equal(u.searchParams.get('unit'),'usd');data=[{time:now-10_000,open:1,high:2,low:0,close:1}];}
    else if(u.pathname.includes('taker-buy'))data={symbol:'TEST',buy_vol_usd:0,sell_vol_usd:0,exchange_list:[]};
    return new Response(JSON.stringify({code:'0',data}));
  });
  const service=new CoinGlassService(client),project={id:'p',tokenSymbol:'TEST'} as MarketProject;
  const initial=await service.project(project);assert.equal(initial.history,undefined);assert.equal(paths.some(p=>p.endsWith('aggregated-history')),false);
  const result=await service.project(project,'24h','4h');assert.equal(result.history?.oi.state,'available');assert.equal(result.history?.funding.state,'available');assert.equal(result.flow.data?.[0].deltaUsd,0);
});
