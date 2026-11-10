import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET, performance, volumeRatio, windowPoints } from '../shared/watch-overview.ts';
const points=Array.from({length:301},(_,i)=>({time:i*BUCKET,close:100+i,volume:10}));
test('returns share an exact closed-candle origin and end',()=>{
  assert.equal(performance(points,300*BUCKET,15),(400/397-1)*100);
  assert.equal(windowPoints(points,300*BUCKET,1440)?.length,289);
  assert.equal(performance(points,301*BUCKET,15),null);
});
test('gaps, duplicates, and nonpositive prices withhold comparison',()=>{
  assert.equal(performance(points.filter((_,i)=>i!==299),300*BUCKET,15),null);
  assert.equal(performance([...points,points[299]],300*BUCKET,15),null);
  assert.equal(performance(points.map((p,i)=>i===299?{...p,close:0}:p),300*BUCKET,15),null);
});
test('volume spike compares against prior twelve complete contiguous buckets',()=>{
  const sample=points.slice(0,13).map((p,i)=>({...p,volume:i===12?30:10}));
  assert.equal(volumeRatio(sample,12),3);
  assert.equal(volumeRatio(sample,11),null);
  assert.equal(volumeRatio(sample.map(p=>({...p,volume:0})),12),null);
  assert.equal(volumeRatio(sample.map((p,i)=>i===5?{...p,time:0}:p),12),null);
});
import { watchOverview } from '../server/watch-overview.ts';
import type { MarketProject } from '../shared/types.ts';
test('overview keeps project scope, deduplicates feeds and excludes unclosed candles',async()=>{
  const original=globalThis.fetch;
  const end=Math.floor(Date.now()/BUCKET)*BUCKET;
  globalThis.fetch=async(input)=>{
    const url=String(input);
    if(url.includes('fundingRate'))return new Response(JSON.stringify([{fundingTime:end-8*3_600_000,fundingRate:'0.001'},{fundingTime:end-4*3_600_000+1,fundingRate:'0.002'}]));
    return new Response(JSON.stringify(Array.from({length:321},(_,i)=>[end-(320-i)*BUCKET,'1','2','1',String(i+1),'10',end-(319-i)*BUCKET-1,'100'])));
  };
  const project=(id:string,exchange='binance',paused=false)=>({id,archived:false,primaryMarketId:'primary',monitoring:{collectionMode:paused?'paused':'active'},markets:[{id:'primary',exchange,marketType:'perpetual',symbol:'TESTUSDT',quote:'USDT'}]}) as MarketProject;
  try{
    const stub={get:async(_symbol:string,_interval:string,limit:number,endTime:number)=>Array.from({length:limit},(_,i)=>({time:endTime-(limit-1-i)*BUCKET,close:i+1,volume:100}))};
    const result=await watchOverview([project('a'),project('b'),project('paused','binance',true),project('unsupported','upbit')],undefined,undefined,stub);
    assert.equal(result.rows.length,3);
    assert.equal(result.rows.find(r=>r.projectId==='a')!.candles.length,320);
    assert.equal(result.rows.find(r=>r.projectId==='a')!.candles.at(-1)!.time,end);
    assert.ok(result.rows.find(r=>r.projectId==='unsupported')!.error);
    assert.equal(result.benchmarks.length,2);
  }finally{globalThis.fetch=original;}
});

import { watchStatus } from '../shared/watch-overview.ts';
test('a failed kline keeps flow/OI usable as PARTIAL instead of ERROR', () => {
  const base = { projectId: 'p', venue: 'binance', symbol: 'X', marketType: 'perpetual', quote: 'USDT', candles: [], error: 'HTTP 502' };
  assert.equal(watchStatus(base as never), 'UNAVAILABLE');
  assert.equal(watchStatus({ ...base, flow: { buy: 1 } } as never), 'PARTIAL');
  assert.equal(watchStatus({ ...base, error: null, funding: { rate: 0.0001, hours: 8, time: 1 } } as never), 'LIVE');
  assert.equal(watchStatus({ ...base, error: null } as never), 'PARTIAL');
});
