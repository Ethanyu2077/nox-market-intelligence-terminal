import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PriceHistory, samplePrices, withStoredPrices } from '../server/price-history.ts';
import type { WatchOverview, WatchRow } from '../shared/watch-overview.ts';

const start = 1_800_000_000_000, key = 'binance:perpetual:JCTUSDT';
function setup(t: {after: (callback: () => void) => void}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'strength-prices-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('one minute commit, no heartbeat writes, source times, late seconds and graceful recovery of a flat tail', t => {
  const directory = setup(t);
  let archive = new PriceHistory(directory);
  const record = (p: number, offset: number) => archive.record(key, p, start + offset, start + offset);
  record(2, 120); record(3, 321); record(4, 2200);
  archive.record(key, 1, start + 1900, start + 2400);
  record(4, 4300);
  assert.equal(archive.status().transactions, 0);
  archive.flush(start + 5100);
  assert.equal(archive.status().transactions, 1);
  record(4, 6200);
  archive.flush(start + 6300);
  archive.flush(start + 7000);
  assert.equal(archive.status().transactions, 1);
  archive.close(start + 7000);
  archive = new PriceHistory(directory);
  const replay = archive.read(key, start, start + 7000, 1000);
  assert.deepEqual(replay.map(({t,p}) => [t-start,p]), [[321,3],[1900,1],[2200,4],[6200,4]]);
  assert.deepEqual(archive.read('binance:spot:JCTUSDT', start, start+7000, 1000), []);
  archive.close(start+7000);
});

test('flat market retains a real observation on day rollover; an idle market actually expires', t => {
  const archive = new PriceHistory(setup(t));
  archive.record(key, 2, start, start);
  archive.record('quiet', 1, start, start);
  for (let n=0; n<=1441; n++) {
    const time = start + n*60_000;
    archive.record(key, 2, time + 1000, time + 1000);
    archive.flush(time + 2000);
  }
  const now = start+1441*60_000+2000;
  assert.equal(archive.read(key, now-60_000, now, 1000).at(-1)?.p, 2);
  assert.deepEqual(archive.read('quiet', start, now, 1000), []);
  archive.close(now);
});

test('real sqlite cap evicts old minutes before retaining the latest, including an over-budget single batch', t => {
  const dir = setup(t), cap = 64*1024;
  let archive = new PriceHistory(dir, cap);
  for (let m=0; m<220; m++) {
    for (let s=0; s<60; s++) {
      const time=start+m*60_000+s*1000;
      archive.record(key, 1+s%7, time, time);
    }
    if (m<100) archive.flush(start+(m+1)*60_000);
  }
  const now = start+220*60_000;
  archive.close(now);
  archive = new PriceHistory(dir, cap);
  const bytes = statSync(path.join(dir,'strength-prices.sqlite')).size;
  assert.ok(bytes<=cap);
  assert.equal(archive.status().bytes, bytes);
  assert.equal(archive.status().maxBytes, cap);
  assert.equal(archive.status().retentionMs, 86_400_000);
  assert.deepEqual(archive.read(key,start,start+59_999,1000),[]);
  assert.equal(archive.read(key,now-60_000,now,1000).length,60);
  assert.equal(archive.read(key,now-60_000,now,1000).at(-1)?.t,now-1000);
  archive.close(now);
});

test('price overview only attaches selected markets and benchmark and preserves true extrema in its bounded window', t => {
  const archive = new PriceHistory(setup(t));
  const row = (id:string): WatchRow => ({projectId:id,venue:'binance',marketType:'perpetual',symbol:id,quote:'USDT',candles:[],error:null});
  const rows=['JCTUSDT','PLAYUSDT'].map(row);
  const data:WatchOverview={asOf:start,end:start,rows,benchmarks:[row('BTCUSDT'),row('ETHUSDT')]};
  for (let s=0;s<65;s++) {
    const time=start+s*1000;
    for (const r of [...rows,...data.benchmarks]) archive.record('binance:perpetual:'+r.symbol, 20+(s===10?10:s===12?-9:s%3),time,time);
  }
  archive.flush(start+65_000);
  const view=withStoredPrices(data,archive,start+65_000,1440,['JCTUSDT'],'BTCUSDT');
  assert.ok(view.rows[0].priceHistory?.some(p=>p.p===30));
  assert.ok(view.rows[0].priceHistory?.some(p=>p.p===11));
  assert.ok(view.benchmarks[0].priceHistory?.length);
  assert.equal(view.rows[1].priceHistory,undefined);
  assert.equal(view.benchmarks[1].priceHistory,undefined);
  assert.equal(rows[0].priceHistory,undefined);
  const prices=Array.from({length:86_400},(_,i)=>({t:start+i*1000,p:100+Math.sin(i/7)}));
  assert.ok(samplePrices(prices,start,start+86_400_000,360_000).length<=960);
  archive.close(start+65_000);
});

test('missing storage is recoverable and the in-memory series stays available', t => {
  const dir = setup(t), missing = path.join(dir, 'initially-unavailable');
  const archive = new PriceHistory(missing);
  archive.record(key, 7, start, start);
  archive.flush(start + 1000);
  assert.ok(archive.status().error);
  assert.deepEqual(archive.read(key,start,start+1000,1000),[{t:start,p:7}]);
  mkdirSync(missing);
  archive.flush(start+2000);
  assert.equal(archive.status().error,null);
  assert.equal(archive.status().pendingMinutes,0);
  archive.close(start+2000);
});
