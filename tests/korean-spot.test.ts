import test from 'node:test';
import assert from 'node:assert/strict';
import {koreanBaseSymbol,normalizeKoreanCatalog,normalizeKoreanSpot,KoreanSpotService} from '../server/korean-spot.ts';
import {orderFlowCapability,normalizeFlowTrade} from '../server/orderflow-adapters.ts';
import {exchangeCapabilities} from '../server/exchanges.ts';
import type {MarketProject,ProjectMarket} from '../shared/types.ts';
const market:ProjectMarket={id:'upbit:spot:KRW-TEST',exchange:'upbit',marketType:'spot',symbol:'KRW-TEST',base:'TEST',quote:'KRW',status:'listed'};
const now=Date.now();
const ticker={market:'KRW-TEST',trade_price:1500,signed_change_rate:-.025,acc_trade_volume_24h:100,acc_trade_price_24h:150000,timestamp:now,trade_timestamp:now};
const book={market:'KRW-TEST',timestamp:now,orderbook_units:[{bid_price:1499,ask_price:1501}]};
test('KRW symbol input aliases and catalog mapping retain native quote-first identity',()=>{
  assert.equal(koreanBaseSymbol('jct-krw'),'JCT');assert.equal(koreanBaseSymbol('KRW-JCT'),'JCT');assert.equal(koreanBaseSymbol('jct/krw'),'JCT');assert.equal(koreanBaseSymbol('JCT'),null);
  const rows=normalizeKoreanCatalog('upbit',[{market:'KRW-TEST'},{market:'KRW-TEST'},{market:'BTC-TEST'},{market:'USDT-TEST'},{market:'not-a-market'}]);
  assert.equal(rows.length,1);assert.equal(rows[0].nativeSymbol,'KRW-TEST');assert.equal(rows[0].base,'TEST');assert.equal(rows[0].quote,'KRW');assert.equal(rows[0].marketType,'spot');assert.throws(()=>normalizeKoreanCatalog('bithumb',{}),/invalid-market-catalog/);
});
test('KRW snapshots preserve prices, turnover, previous-close semantics and never expose USD, OI or CVD',()=>{
  const s=normalizeKoreanSpot(market,ticker,book,now);
  assert.equal(s.priceKrw,1500);assert.equal(s.turnover24hKrw,150000);assert.equal(s.changeFromPreviousClosePct,-2.5);assert.ok(s.spreadBps!>0);assert.equal(s.quality,'live');
  for(const key of ['volume24hUsd','oiUsd','fundingRate','cvd'])assert.equal(key in s,false);
  assert.equal(normalizeKoreanSpot(market,{...ticker,acc_trade_price_24h:0},null,now).turnover24hKrw,0);
  assert.equal(normalizeKoreanSpot(market,{...ticker,acc_trade_price_24h:null},null,now).turnover24hKrw,null);
  assert.equal(orderFlowCapability(market).available,false);assert.equal(normalizeFlowTrade(market,{a:'t',p:1500,q:1,m:false,T:now},1),null);
});
test('identity mismatches and stale, crossed or unknown-time books cannot silently become current quotes',()=>{
  assert.throws(()=>normalizeKoreanSpot(market,{...ticker,market:'KRW-OTHER'},book,now),/identity-mismatch/);
  assert.throws(()=>normalizeKoreanSpot({...market,marketType:'perpetual'},ticker,book,now),/unsupported-market/);
  assert.equal(normalizeKoreanSpot(market,ticker,{...book,timestamp:now-100000},now).bidKrw,null);
  assert.equal(normalizeKoreanSpot(market,ticker,{...book,market:'KRW-OTHER'},now).bookState,'unavailable');
  assert.equal(normalizeKoreanSpot(market,ticker,{...book,orderbook_units:[{bid_price:1502,ask_price:1501}]},now).askKrw,null);
  assert.equal(normalizeKoreanSpot(market,{...ticker,timestamp:now-100000},book,now).quality,'stale');
  assert.equal(normalizeKoreanSpot(market,{...ticker,timestamp:null},book,now).quality,'partial');
  const future=normalizeKoreanSpot(market,{...ticker,timestamp:now+9*3600_000},book,now);assert.equal(future.timestampIssue,'future-source-time');assert.equal(future.sourceTime,null);assert.equal(future.rawSourceTime,now+9*3600_000);
});
test('selected KRW markets use fixed origins, deduplicate, retain source ages and isolate orderbook failure',async()=>{
  let calls=0;const service=new KoreanSpotService(async(url,init)=>{
    calls++;const u=new URL(String(url));assert.ok(['https://api.upbit.com','https://api.bithumb.com'].includes(u.origin));assert.equal(init?.redirect,'error');
    if(u.pathname.endsWith('/all'))return new Response(JSON.stringify([{market:'KRW-TEST'}]));
    assert.equal(u.searchParams.get('markets'),'KRW-TEST');
    if(u.pathname.endsWith('/orderbook'))return new Response('unavailable',{status:503});
    return new Response(JSON.stringify([ticker]));
  });
  const project={id:'p',markets:[market,market,{...market,id:'other',exchange:'binance',quote:'USDT'}]} as MarketProject;
  const [a,b]=await Promise.all([service.project(project),service.project(project)]);
  assert.equal(calls,3);assert.equal(a.requested,1);assert.equal(a.items.length,1);assert.equal(a.items[0].bookState,'unavailable');assert.equal(a.items[0].sourceTime,now);assert.equal(a.items[0].fetchedAt,b.items[0].fetchedAt);
  const again=await service.project(project);assert.equal(again.items[0].fetchedAt,a.items[0].fetchedAt);
});
test('unlisted KRW pairs never cause ticker requests; errors retain selected-market identity',async()=>{
  let calls=0;const service=new KoreanSpotService(async()=>{calls++;return new Response(JSON.stringify([{market:'KRW-OTHER'}]));});
  const result=await service.project({id:'p',markets:[market]} as MarketProject);
  assert.equal(calls,1);assert.equal(result.items.length,0);assert.equal(result.failures[0].reason,'market-not-listed');assert.equal(result.failures[0].symbol,'KRW-TEST');
});
test('new spot venues disclose unsupported derivatives/streaming capabilities',()=>{
  for(const exchange of ['upbit','bithumb']){const c=exchangeCapabilities().find(c=>c.exchange===exchange)!;assert.ok(c.restDiscovery&&c.restSnapshot);assert.equal(c.openInterest,false);assert.equal(c.funding,false);assert.equal(c.websocketTrades,false);assert.equal(c.websocketTicker,false);}
});

