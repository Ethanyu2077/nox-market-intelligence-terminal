import assert from 'node:assert/strict';
import test from 'node:test';
import { clearVolumeMatrixCache, volumeMatrix } from '../server/volume-matrix.ts';
import type { MarketProject, ProjectMarket, VenueMarketSnapshot } from '../shared/types.ts';
import type { KoreanSpotSnapshot } from '../shared/korean-spot.ts';

const NOW = Date.now();
const THEME = { color: 'x' };
void THEME;

const market = (exchange: 'binance' | 'upbit', marketType: 'spot' | 'perpetual', symbol: string, quote: string): ProjectMarket => ({
  id: `${exchange}:${marketType}:${symbol}`, exchange, marketType, symbol, base: 'ARB', quote, status: 'trading',
});
const project: MarketProject = {
  id: 'p-int', name: 'ARB', tokenSymbol: 'ARB', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
  markets: [market('binance', 'spot', 'ARBUSDT', 'USDT'), market('binance', 'perpetual', 'ARBUSDT', 'USDT'), market('upbit', 'spot', 'KRW-ARB', 'KRW')],
  primaryMarketId: 'binance:perpetual:ARBUSDT', monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: 'active' }, archived: false, order: 0, createdAt: NOW, updatedAt: NOW,
};
const perpSnapshot: VenueMarketSnapshot = {
  exchange: 'binance', symbol: 'ARBUSDT', marketType: 'perpetual', price: 0.166, markPrice: 0.1661, change24hPct: -1, volume24hBase: 1_000, volume24hUsd: 5_000,
  takerBuyVolumeUsd: null, takerSellVolumeUsd: null, volumeDeltaUsd: null, cvd: null, oiBase: 10, oiUsd: 1.66, oiDeltaBase: null, oiDeltaUsd: null,
  fundingRate: 0.0001, nextFundingTime: NOW, bid: null, ask: null, spreadBps: null, eventTime: NOW, fetchedAt: NOW, quality: 'live', source: 'fixture', unavailable: [],
};
const krwSnapshot: KoreanSpotSnapshot = {
  market: market('upbit', 'spot', 'KRW-ARB', 'KRW'), quote: 'KRW', priceKrw: 224, changeFromPreviousClosePct: 0.5,
  volume24hBase: 1_000, turnover24hKrw: 1_000_000, bidKrw: 223.9, askKrw: 224.1, spreadBps: 8.9,
  sourceTime: NOW, rawSourceTime: NOW, timestampIssue: null, lastTradeTime: NOW, bookTime: NOW, fetchedAt: NOW, quality: 'live', bookState: 'available', source: 'fixture',
};

test('volumeMatrix composes spot fetch, perpetual fetcher, KRW service, failures and cache', async () => {
  clearVolumeMatrixCache();
  let spotFetches = 0, perpFetches = 0, krwFetches = 0;
  const fetchImpl = (async () => {
    spotFetches += 1;
    return new Response(JSON.stringify({ symbol: 'ARBUSDT', lastPrice: '0.166', volume: '5000', quoteVolume: '1000', closeTime: NOW }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const matrix = await volumeMatrix(project, {
    now: NOW,
    fetchImpl,
    perpFetcher: async () => { perpFetches += 1; return perpSnapshot; },
    krwFetcher: async () => { krwFetches += 1; return { items: [krwSnapshot], failures: [{ exchange: 'bithumb', symbol: 'KRW-ARB', reason: 'rate-limited' }] }; },
  });
  assert.equal(spotFetches, 1);
  assert.equal(perpFetches, 1);
  assert.equal(krwFetches, 1);
  assert.equal(matrix.rows.length, 1, 'KRW venues stay out of the USDT rows');
  assert.equal(matrix.rows[0].spot?.volume24hUsd, 1_000);
  assert.equal(matrix.rows[0].perpetual?.volume24hUsd, 5_000);
  assert.equal(matrix.totals.spotPerpRatio, 0.2);
  assert.equal(matrix.krw.totals.spotKrw, 1_000_000);
  assert.equal(matrix.krw.rows.find((row) => row.exchange === 'upbit')?.spotSharePct, 100);
  assert.ok(matrix.krw.claimGate.reasons.some((reason) => reason.includes('KRW request')));
  // The 15s cache must prevent a second network fan-out for the same project/markets.
  const again = await volumeMatrix(project, { fetchImpl, perpFetcher: async () => { perpFetches += 1; return perpSnapshot; } });
  assert.equal(again, matrix);
  assert.equal(spotFetches, 1);
  assert.equal(perpFetches, 1);
  clearVolumeMatrixCache();
});
