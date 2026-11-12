import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketProject } from '../shared/types.ts';
import type { WatchlistQuote, WatchPriceTick } from '../shared/watchlist.ts';
import { boardMarkets, mergeBoardPrices, updateBoardPrices } from '../shared/watchlist-live-prices.ts';

function project(id: string): MarketProject {
  const market = { id, exchange: 'binance', marketType: 'perpetual', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', status: 'TRADING' } as const;
  return { id, name: id, tokenSymbol: id, archived: false, markets: [market], primaryMarketId: id,
    monitoring: { streamingEnabled: true, collectionMode: 'active', defaultInterval: '5m' },
    contractAddress: null, identitySource: 'symbol', identityNetwork: null, order: 0, createdAt: 0, updatedAt: 0 };
}
const markets = boardMarkets([project('p')]);
const rest: WatchlistQuote = {projectId: 'p', price: 90, eventTime: 1000, quality: 'live', exchange: 'binance', marketType: 'perpetual',
  symbol: 'BTCUSDT', change24hPct: 2, volume24hUsd: 100000, oiUsd: 500, fundingRate: .01, spreadBps: 1, sparkline: [85,90], error: null };
function tick(at: number, price: number): WatchPriceTick {
  return {projectId: 'p', marketKey: markets[0].marketKey, priceAt: at, at, price, change24hPct: 99, stale: false};
}

test('project quote board streams at most 12 visible monitored markets', () => {
  const all = Array.from({length: 18}, (_, i) => project(String(i)));
  all[0].archived = true; all[1].monitoring.streamingEnabled = false; all[2].monitoring.collectionMode = 'paused'; all[3].markets = [];
  assert.deepEqual(boardMarkets(all).map(m => m.projectId), all.slice(4,16).map(p => p.id));
  assert.equal(boardMarkets(all.slice(-1))[0].projectId, '17');
});

test('real prices merge by venue, kind, symbol and time; the snapshot supplies all other fields', () => {
  const live = updateBoardPrices(new Map(), markets, [tick(2000,110)], 2100);
  assert.deepEqual(mergeBoardPrices([rest], markets, live), [{...rest, price: 110, eventTime: 2000}]);
  const newer = {...rest, price: 120, eventTime: 3000};
  assert.deepEqual(mergeBoardPrices([newer], markets, live), [newer]);
  assert.equal(updateBoardPrices(live, markets, [tick(1800,95),tick(99999,60)], 2100), live);
  assert.equal(updateBoardPrices(live, markets, [{...tick(2100,5), marketKey: 'binance:spot:BTCUSDT'}],2100), live);
  assert.equal(updateBoardPrices(live, markets, [tick(99_000,40)],2100), live);
  assert.equal(updateBoardPrices(live, markets, [tick(2100,NaN)],2100), live);
  const other = {...rest, marketType: 'spot' as const};
  const isolated = mergeBoardPrices([other],markets,live)[0];
  assert.equal(isolated.price, 110);
  assert.equal(isolated.sparkline, null);
  assert.equal(isolated.quality, 'partial');
  assert.deepEqual(mergeBoardPrices([other],markets,new Map()), []);
  const remapped = project('p');
  remapped.markets[0].exchange = 'bybit';
  const bybit = boardMarkets([remapped]);
  assert.deepEqual(mergeBoardPrices([rest], bybit, live), []);
  const bybitTick = {...tick(4000,130), marketKey: bybit[0].marketKey};
  const newPrices = updateBoardPrices(live, bybit, [bybitTick], 4000);
  assert.equal(updateBoardPrices(newPrices, bybit, [tick(4100,190)], 4100), newPrices);
  const newRow = mergeBoardPrices([rest], bybit, newPrices)[0];
  assert.equal(newRow.exchange,'bybit');
  assert.equal(newRow.price,130);
  assert.equal(newRow.oiUsd,null);
});

test('feed silence and transport loss hold the last quote as delayed, a newer REST observation wins', () => {
  const live = updateBoardPrices(new Map(), markets, [tick(2000,110)], 2100);
  for (const stale of [updateBoardPrices(live,markets,[tick(2000,110)],8000),updateBoardPrices(live,markets,[],2100,false)]) {
    assert.equal(mergeBoardPrices([rest],markets,stale)[0].quality,'stale');
    assert.equal(mergeBoardPrices([],markets,stale)[0].price,110);
    assert.equal(mergeBoardPrices([{...rest,eventTime:9000,price:111}],markets,stale)[0].price,111);
  }
  assert.equal(updateBoardPrices(live,[],[],2100).size,0);
});
