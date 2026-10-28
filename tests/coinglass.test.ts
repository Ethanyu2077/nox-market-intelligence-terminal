import test from 'node:test';
import assert from 'node:assert/strict';
import {CoinGlassClient,CoinGlassService,normalizeCoinGlassOi,normalizeCoinGlassFunding,normalizeCoinGlassLiquidations} from '../server/coinglass.ts';
import {normalizeWeb3Advanced} from '../server/binance-web3.ts';
import type {MarketProject} from '../shared/types.ts';
const project={id:'p',tokenSymbol:'TEST'} as MarketProject;
const ok=(data:unknown)=>new Response(JSON.stringify({code:'0',data}));
test('CoinGlass missing keys and forbidden endpoints never send a request',async()=>{
  let calls=0;const client=new CoinGlassClient('',async()=>{calls++;return ok([]);});
  assert.equal((await new CoinGlassService(client).project(project)).oi.state,'not-configured');
  await assert.rejects(client.request('/api/trade'),/endpoint-not-allowed/);assert.equal(calls,0);
});
test('CoinGlass authenticates only at the fixed origin, deduplicates and preserves cached fetch time',async()=>{
  let calls=0;const client=new CoinGlassClient('test-secret',async(url,init)=>{calls++;assert.equal(new URL(String(url)).origin,'https://open-api-v4.coinglass.com');assert.equal(new Headers(init?.headers).get('CG-API-KEY'),'test-secret');assert.equal(init?.redirect,'error');return ok(['TEST']);});
  const [a,b]=await Promise.all([client.request('/api/futures/supported-coins'),client.request('/api/futures/supported-coins')]);
  assert.equal(calls,1);assert.equal(a.fetchedAt,b.fetchedAt);assert.equal((await client.request('/api/futures/supported-coins')).fetchedAt,a.fetchedAt);
});
test('CoinGlass rate limits respect cooldown and never leak upstream error bodies',async()=>{
  let calls=0;const client=new CoinGlassClient('secret',async()=>{calls++;return new Response('private upstream secret',{status:429,headers:{'Retry-After':'30'}});});
  await assert.rejects(client.request('/api/futures/supported-coins'),/^Error: rate-limited$/);
  await assert.rejects(client.request('/api/futures/supported-coins'),/rate-limited/);assert.equal(calls,1);
});
test('CoinGlass business authentication errors are sanitized',async()=>{
  const client=new CoinGlassClient('secret',async()=>new Response(JSON.stringify({code:'401',msg:'secret'})));
  await assert.rejects(client.request('/api/futures/supported-coins'),/^Error: authentication-failed$/);
});
test('normalizers keep zero and missing separate; do not sum All, mix margin types or use wrong identity',()=>{
  const oi=normalizeCoinGlassOi([{exchange:'All',symbol:'TEST',open_interest_usd:'0'},{exchange:'A',symbol:'TEST',open_interest_usd:null},{exchange:'B',symbol:'WRONG',open_interest_usd:100}],'TEST');
  assert.equal(oi.length,2);assert.equal(oi[0].oiUsd,0);assert.equal(oi[1].oiUsd,null);
  const funding=normalizeCoinGlassFunding([{symbol:'TEST',stablecoin_margin_list:[{exchange:'A',funding_rate:-0.01}],token_margin_list:[{exchange:'A',funding_rate:0}]}],'TEST');
  assert.equal(funding.length,2);assert.equal(funding[0].rateRaw,-0.01);assert.equal(funding[1].margin,'coin');
  assert.equal(normalizeCoinGlassLiquidations([{exchange:'All',liquidation_usd:0}])[0].longUsd,null);
  assert.throws(()=>normalizeCoinGlassOi({},'TEST'),/invalid-response/);
});
test('CoinGlass validates support and isolates endpoint failures',async()=>{
  const client=new CoinGlassClient('key',async url=>{
    const u=new URL(String(url));if(u.pathname.endsWith('supported-coins'))return ok(['TEST']);
    if(u.pathname.includes('funding-rate'))return new Response('plan restriction',{status:403});
    assert.equal(u.searchParams.get('symbol'),'TEST');
    if(u.pathname.includes('liquidation')){assert.equal(u.searchParams.get('range'),'24h');return ok([{exchange:'All',liquidation_usd:0}]);}
    return ok([{exchange:'All',symbol:'TEST',open_interest_usd:1}]);
  });
  const result=await new CoinGlassService(client).project(project);
  assert.equal(result.oi.state,'available');assert.equal(result.funding.reason,'permission-or-plan-restricted');assert.equal(result.liquidations.data?.[0].totalUsd,0);assert.equal(result.oi.sourceTime,null);
  assert.ok(!JSON.stringify(result).includes('key'));
});
test('unsupported CoinGlass symbols never request coin-specific data',async()=>{
  let calls=0;const service=new CoinGlassService(new CoinGlassClient('key',async()=>{calls++;return ok(['OTHER']);}));
  assert.equal((await service.project(project)).oi.state,'unsupported');assert.equal(calls,1);
});
test('Binance holder categories retain percentages, discard impossible data and preserve missing values',()=>{
  const r=normalizeWeb3Advanced({top10HoldingPercent:'40.08',devHoldingPercent:'0',smartMoneyHoldingPercent:'101',holders:'25',tokenTags:['devSell',42]});
  assert.equal(r.holdingPercent.top10,40.08);assert.equal(r.holdingPercent.dev,0);assert.equal(r.holdingPercent.smartMoney,null);assert.equal(r.holdingPercent.insider,null);assert.deepEqual(r.tags,['devSell']);
});
test('real CoinGlass capability authentication (explicit opt-in)', {skip:process.env.NOX_TEST_COINGLASS_LIVE!=='true'}, async()=>{
  const client=new CoinGlassClient();assert.ok(client.configured,'Set COINGLASS_API_KEY on the server');
  const response=await client.request('/api/futures/supported-coins');
  assert.ok(Array.isArray(response.data)&&response.data.length>0,'Expected supported coin list');
});
