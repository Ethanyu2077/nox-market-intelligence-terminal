import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET, historicalStrengthPoints, performance, volumeRatio, windowPoints, type WatchRow } from '../shared/watch-overview.ts';
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

const chartRow: WatchRow = {
  projectId: 'sample', venue: 'binance', symbol: 'SAMPLEUSDT', marketType: 'perpetual', quote: 'USDT', error: null,
  candles: [8, 10, 12].map((close, i) => ({ time: i * BUCKET, close, volume: 1 })),
};
test('historical price points use matching 5m timestamps and benchmark percentage points', () => {
  const end = 2 * BUCKET;
  const reference = { ...chartRow, candles: chartRow.candles.map((candle, i) => ({ ...candle, close: 16 + i })) };
  assert.deepEqual(historicalStrengthPoints(chartRow, reference, end, 10, 'price', 'BTCUSDT'), [
    { t: 0, value: 0 }, { t: BUCKET, value: 18.75 }, { t: end, value: 37.5 },
  ]);
  assert.equal(historicalStrengthPoints(chartRow, reference, end, 10, 'price', 'absolute').at(-1)?.value, 50);
  const partial = { ...reference, candles: reference.candles.slice(1) };
  assert.deepEqual(historicalStrengthPoints(chartRow, partial, end, 10, 'price', 'BTCUSDT'), []);
  assert.deepEqual(historicalStrengthPoints(partial, reference, end, 10, 'price', 'absolute'), []);
});

test('historical CVD, net flow and OI keep observed timestamps, including gaps and zero values', () => {
  const end = 2 * BUCKET;
  const row: WatchRow = {
    ...chartRow,
    flow: {
      buy: 0, sell: 0, delta: 0, cvd: 0, spotDelta: 0, perpDelta: 0, covered: 1, requested: 1,
      source: 'orderflow', venues: [], buckets: [
        { time: 0, buy: null, sell: null, cvd: 15, delta: -15 },
        { time: BUCKET, buy: null, sell: null, cvd: null, delta: null },
        { time: end, buy: null, sell: null, cvd: 0, delta: 0 },
      ],
    },
    oiSeries: [{ time: BUCKET, oiUsd: 20 }, { time: end, oiUsd: 25 }],
  };
  assert.deepEqual(historicalStrengthPoints(row, undefined, end, 10, 'cvd', 'absolute'), [{ t: 0, value: 0 }, { t: end, value: -15 }]);
  assert.deepEqual(historicalStrengthPoints(row, undefined, end, 10, 'flow', 'absolute'), [{ t: 0, value: -15 }, { t: end, value: -15 }]);
  assert.deepEqual(historicalStrengthPoints(row, undefined, end, 10, 'oi', 'absolute'), [{ t: BUCKET, value: 0 }, { t: end, value: 25 }]);
  assert.deepEqual(historicalStrengthPoints({ ...row, oiSeries: [{ time: 0, oiUsd: 0 }] }, undefined, end, 10, 'oi', 'absolute'), []);
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

import { buildWatchMetrics } from '../shared/watch-overview.ts';
test('metric detail separates price from flow, OI and funding', () => {
  const row = { projectId: 'p', venue: 'binance', symbol: 'X', marketType: 'perpetual', quote: 'USDT', candles: [{ time: 1, close: 1, volume: 1 }], funding: { rate: 0.0001, hours: 8, time: 2 }, oiSeries: [{ time: 1, oiUsd: 1 }, { time: 2, oiUsd: 2 }], flow: { buy: 10, sell: 8, delta: 2, cvd: 2, spotDelta: 0, perpDelta: 2, buckets: [{ time: 3, buy: 10, sell: 8, delta: 2, cvd: 2 }], venues: [], covered: 1, requested: 1, source: 'orderflow' }, error: null };
  const metrics = buildWatchMetrics(row as never);
  assert.equal(metrics.price.state, 'LIVE');
  assert.equal(metrics.oi.state, 'LIVE');
  assert.equal(metrics.cvd.state, 'LIVE');
  const partial = buildWatchMetrics({ ...row, candles: [], error: 'HTTP 502' } as never);
  assert.equal(partial.kline.state, 'UNAVAILABLE');
  assert.equal(partial.perp.state, 'LIVE');
  assert.equal(partial.spot.state, 'LIVE');
  const noFlow = buildWatchMetrics({ ...row, flow: null } as never);
  assert.equal(noFlow.perp.state, 'UNAVAILABLE');
  assert.equal(noFlow.cvd.state, 'UNAVAILABLE');
});
test('missing flow uses explicit enums, not empty values', () => {
  const row = { projectId: 'p', venue: 'binance', symbol: 'X', marketType: 'perpetual', quote: 'USDT', candles: [], error: null, flow: null, collectionMode: 'standard', hasSpot: false, hasPerp: true };
  const metrics = buildWatchMetrics(row as never);
  assert.equal(metrics.spot.state, 'UNAVAILABLE');
  assert.equal(metrics.spot.error, 'UNSUPPORTED');
  assert.equal(metrics.perp.error, 'COLLECTOR_NOT_STARTED');
  assert.equal(metrics.cvd.error, 'COLLECTOR_NOT_STARTED');
  assert.equal(buildWatchMetrics({ ...row, collectionMode: 'active' } as never).perp.error, 'NO_TRADES_IN_WINDOW');
});
