import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import {AuthStore} from '../server/auth.ts';
import {installCoinGlassAccess,coinGlassResearchContext} from '../server/coinglass-access.ts';

async function fixture(){
  const auth=new AuthStore(await mkdtemp(path.join(tmpdir(),'nox-cg-access-')));await auth.init();
  const app=express();app.use(express.json());auth.install(app);installCoinGlassAccess(app,auth);
  let providerCalls=0;
  const cachedProviderResult={paidMetrics:'fixture-private-CoinGlass-data'};
  const provider=async()=>{providerCalls++;return cachedProviderResult;};
  app.get('/api/coinglass/capabilities',(_req,res)=>res.json({configured:true}));
  app.get('/api/projects/:id/coinglass',async(_req,res)=>res.json(await provider()));
  app.get('/api/projects/:id/provider-crosscheck',async(_req,res)=>res.json(await provider()));
  app.get('/api/settings/providers/coinglass',(_req,res)=>res.json({configured:true}));
  app.put('/api/settings/providers/coinglass',(_req,res)=>res.json({ok:true}));
  app.delete('/api/settings/providers/coinglass',(_req,res)=>res.json({ok:true}));
  app.post('/api/settings/providers/coinglass/test',(_req,res)=>res.json({ok:true}));
  app.get('/api/projects/:id/research-context',async(req,res)=>res.json({publicMarketData:true,coinglass:await coinGlassResearchContext(auth,req,provider)}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  const request=(method:string,route:string,cookie='',body:unknown={})=>fetch(base+route,{method,headers:{cookie,'Content-Type':'application/json'},...(['POST','PUT'].includes(method)?{body:JSON.stringify(body)}:{})});
  const setup=await request('POST','/auth/setup','',{name:'owner',password:'8charpwd',token:auth.setSetupToken()});assert.equal(setup.status,200);
  const cookies:Record<string,string>={owner:setup.headers.get('set-cookie')!.split(';')[0]};
  for(const role of ['admin','analyst','viewer']){
    assert.equal((await request('POST','/auth/users',cookies.owner,{name:role,password:'8charpwd',role})).status,201);
    const login=await request('POST','/auth/login','',{name:role,password:'8charpwd'});assert.equal(login.status,200);cookies[role]=login.headers.get('set-cookie')!.split(';')[0];
  }
  return {request,cookies,calls:()=>providerCalls,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));auth.close();}};
}

test('all CoinGlass capabilities, metrics/history and key endpoints require an administrator before returning provider data',async()=>{
  const app=await fixture();
  const routes=[['GET','/coinglass/capabilities'],['HEAD','/coinglass/capabilities'],['GET','/projects/p/coinglass'],['GET','/projects/p/coinglass?range=4h&history=1h'],['HEAD','/projects/p/coinglass'],['GET','/projects/p/provider-crosscheck'],['GET','/settings/providers/coinglass'],['PUT','/settings/providers/coinglass'],['DELETE','/settings/providers/coinglass'],['POST','/settings/providers/coinglass/test']];
  try{
    for(const role of ['anonymous','analyst','viewer']){
      for(const [method,route] of routes){
        const response=await app.request(method,route,app.cookies[role]);assert.equal(response.status,role==='anonymous'?401:403,`${role}: ${method} ${route}`);
        assert.ok(!(await response.text()).includes('fixture-private-CoinGlass-data'));
      }
    }
    assert.equal(app.calls(),0);
    for(const role of ['owner','admin']){
      for(const [method,route] of routes){
        const response=await app.request(method,route,app.cookies[role]);assert.equal(response.status,200,`${role}: ${method} ${route}`);
        assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('vary')??'',/Cookie/);
      }
    }
    const before=app.calls();
    assert.equal((await app.request('GET','/projects/p/coinglass',app.cookies.viewer)).status,403);
    assert.equal(app.calls(),before,'Cached administrator data must not bypass authorization');
    assert.equal((await app.request('DELETE','/auth/users/admin',app.cookies.owner)).status,204);
    assert.equal((await app.request('GET','/projects/p/coinglass',app.cookies.admin)).status,401);
    assert.equal(app.calls(),before,'Deleting an administrator revokes CoinGlass access immediately');
  }finally{await app.close();}
});

test('public and ordinary-account research exports omit CoinGlass and never invoke the provider, including after an administrator warmed the cache',async()=>{
  const app=await fixture();
  try{
    for(const role of ['owner','admin']){
      const response=await app.request('GET','/projects/p/research-context',app.cookies[role]);assert.equal(response.status,200);
      assert.equal((await response.json()).coinglass.paidMetrics,'fixture-private-CoinGlass-data');
      assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('vary')??'',/Cookie/);
    }
    const before=app.calls();
    for(const role of ['anonymous','analyst','viewer']){
      const response=await app.request('GET','/projects/p/research-context',app.cookies[role]);assert.equal(response.status,200);
      assert.deepEqual(await response.json(),{publicMarketData:true});
      assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('vary')??'',/Cookie/);
    }
    assert.equal(app.calls(),before);
  }finally{await app.close();}
});
